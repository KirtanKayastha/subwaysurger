/**
 * Backend client with an offline-first fallback.
 *
 * The game must be fully playable with no server: open the HTML directly, lose
 * your network mid-run, or run the backend and get a shared leaderboard. This
 * module hides that difference behind one API.
 *
 * Strategy:
 *   * Every read tries the server, then falls back to the localStorage mirror.
 *   * Every write updates localStorage first (so it is never lost), then
 *     attempts to sync.
 *   * A single failed request flips `online` to false and schedules a cheap
 *     health re-check, so we do not stall each call on a dead socket.
 */

import { STORAGE_KEYS } from './engine/constants.js';
import { storage } from './engine/util.js';

/** Abort a request that takes longer than this (ms). */
const TIMEOUT_MS = 6000;
/** How long to stay in offline mode before re-probing the server. */
const RETRY_AFTER_MS = 15000;

/**
 * Shop catalog used when the server is unreachable.
 * Kept in sync with `server/app/config.py::SHOP_CATALOG` - the server remains
 * authoritative whenever it is available.
 */
export const OFFLINE_SHOP = [
  { id: 'magnet_duration', name: 'Magnet Coil', desc: 'Coin magnet lasts longer.',
    icon: 'magnet', kind: 'upgrade', levels: 5, base_price: 250, growth: 1.9,
    effect: { stat: 'magnetSeconds', base: 6.0, per_level: 1.6 } },
  { id: 'shield_duration', name: 'Aegis Field', desc: 'Shield holds out longer.',
    icon: 'shield', kind: 'upgrade', levels: 5, base_price: 300, growth: 1.9,
    effect: { stat: 'shieldSeconds', base: 5.0, per_level: 1.4 } },
  { id: 'turbo_duration', name: 'Ion Thrusters', desc: 'Turbo boost runs hotter and longer.',
    icon: 'turbo', kind: 'upgrade', levels: 5, base_price: 350, growth: 2.0,
    effect: { stat: 'turboSeconds', base: 4.0, per_level: 1.2 } },
  { id: 'coin_value', name: 'Alloy Refinery', desc: 'Every coin is worth more score.',
    icon: 'coin', kind: 'upgrade', levels: 5, base_price: 400, growth: 2.1,
    effect: { stat: 'coinScore', base: 10.0, per_level: 4.0 } },
  { id: 'head_start', name: 'Launch Rails', desc: 'Begin each run further down the line.',
    icon: 'rocket', kind: 'upgrade', levels: 4, base_price: 500, growth: 2.2,
    effect: { stat: 'headStartMetres', base: 0.0, per_level: 250.0 } },
  { id: 'combo_grace', name: 'Flow State', desc: 'Combo chain survives longer between pickups.',
    icon: 'combo', kind: 'upgrade', levels: 4, base_price: 450, growth: 2.0,
    effect: { stat: 'comboGrace', base: 2.2, per_level: 0.45 } },
  { id: 'hoverboard', name: 'Hoverboard', desc: 'Consumable. Survives one fatal hit.',
    icon: 'board', kind: 'consumable', levels: 0, base_price: 150, growth: 1.0,
    max_stock: 9, effect: { stat: 'hoverboards', base: 0.0, per_level: 1.0 } },
];

export const OFFLINE_SKINS = [
  { id: 'cyan', name: 'Cyan Default', price: 0, colors: ['#22e8ff', '#0b7fa8'] },
  { id: 'magenta', name: 'Hot Circuit', price: 300, colors: ['#ff3ea5', '#8c1550'] },
  { id: 'lime', name: 'Toxic Lime', price: 300, colors: ['#b9ff2e', '#4f8c15'] },
  { id: 'gold', name: 'Bullion', price: 900, colors: ['#ffd23e', '#8c6a15'] },
  { id: 'void', name: 'Void Walker', price: 1500, colors: ['#a06bff', '#4a2596'] },
];

/** Price of the next tier - mirrors `config.price_for`. */
export function priceFor(item, level) {
  if (!item) return Infinity;
  if (item.levels === 0) return item.base_price;
  return Math.round(item.base_price * Math.pow(item.growth, level));
}

/** Shape of a fresh local profile. */
function blankProfile() {
  return {
    name: 'RUNNER',
    coins: 0,
    totalCoins: 0,
    bestScore: 0,
    bestDistance: 0,
    runs: 0,
    playMs: 0,
    skin: 'cyan',
    upgrades: {},
    ownedSkins: ['cyan'],
    progress: {},
    rank: null,
    local: true,
  };
}

export class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    this.token = storage.get(STORAGE_KEYS.token, null);
    this.online = false;
    this._nextProbe = 0;
    /** Cached catalogs (server-provided when online). */
    this.shop = OFFLINE_SHOP;
    this.skins = OFFLINE_SKINS;
    /** Listeners for connectivity changes. */
    this.onStatusChange = null;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  _setOnline(value) {
    if (this.online === value) return;
    this.online = value;
    if (!value) this._nextProbe = Date.now() + RETRY_AFTER_MS;
    if (this.onStatusChange) this.onStatusChange(value);
  }

  /**
   * Perform a request. Returns the parsed body, or null on any failure.
   * Never throws - callers always have a local fallback path.
   */
  async _request(path, { method = 'GET', body = null, auth = true } = {}) {
    // Skip the network entirely while in the offline back-off window.
    if (!this.online && Date.now() < this._nextProbe && path !== '/api/health') {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

      const response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok && response.status >= 500) {
        this._setOnline(false);
        return null;
      }

      const data = await response.json();
      this._setOnline(true);
      return data;
    } catch {
      // Network error, timeout, or the server is not running.
      this._setOnline(false);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /**
   * Connect, registering a player if this browser has no token yet.
   * Always resolves with a usable profile.
   */
  async init() {
    const health = await this._request('/api/health', { auth: false });

    if (health && health.ok) {
      const config = await this._request('/api/config', { auth: false });
      if (config && config.ok) {
        this.shop = config.shop || OFFLINE_SHOP;
        this.skins = config.skins || OFFLINE_SKINS;
      }

      // Existing token: fetch the profile. A 401 means the DB was reset, so
      // fall through and register again.
      if (this.token) {
        const me = await this._request('/api/me');
        if (me && me.ok && me.player) {
          this._cacheProfile(me.player);
          return me.player;
        }
        this.token = null;
        storage.remove(STORAGE_KEYS.token);
      }

      const local = this._localProfile();
      const registered = await this._request('/api/register', {
        method: 'POST', auth: false, body: { name: local.name },
      });
      if (registered && registered.ok) {
        this.token = registered.token;
        storage.set(STORAGE_KEYS.token, this.token);
        this._cacheProfile(registered.player);
        return registered.player;
      }
    }

    // Offline: hand back the local mirror.
    return this._localProfile();
  }

  // -------------------------------------------------------------------------
  // Local mirror
  // -------------------------------------------------------------------------

  _localProfile() {
    const stored = storage.get(STORAGE_KEYS.profile, null);
    return stored ? { ...blankProfile(), ...stored } : blankProfile();
  }

  _cacheProfile(profile) {
    if (!profile) return;
    storage.set(STORAGE_KEYS.profile, profile);
  }

  _saveLocal(mutator) {
    const profile = this._localProfile();
    mutator(profile);
    storage.set(STORAGE_KEYS.profile, profile);
    return profile;
  }

  /** Locally-stored score history, used for the offline leaderboard. */
  _localScores() {
    return storage.get(STORAGE_KEYS.scores, []);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Ask the server to open a run session.
   * Returns `{ runToken, seed }`; offline, a local seed is generated.
   */
  async startRun() {
    const response = await this._request('/api/run/start', { method: 'POST' });
    if (response && response.ok) {
      return { runToken: response.runToken, seed: response.seed };
    }
    return { runToken: null, seed: (Math.random() * 0x7fffffff) >>> 0 };
  }

  /**
   * Submit a finished run.
   *
   * Local state is always updated first so progress survives a failed request.
   * Returns `{ profile, accepted, personalBest, coinsBanked }`.
   */
  async submitRun(result, runToken) {
    const banked = Math.floor(result.coins) +
      Math.floor((result.distance / 1000) * 40);

    // 1. Local first - never lose the player's progress to a network blip.
    const local = this._saveLocal((profile) => {
      profile.coins += banked;
      profile.totalCoins += banked;
      profile.bestScore = Math.max(profile.bestScore, result.score);
      profile.bestDistance = Math.max(profile.bestDistance, result.distance);
      profile.runs += 1;
      profile.playMs += result.durationMs;
    });

    const personalBestLocal = result.score >= local.bestScore;

    const history = this._localScores();
    history.push({
      name: local.name,
      score: result.score,
      distance: result.distance,
      coins: result.coins,
      createdMs: Date.now(),
      mine: true,
    });
    history.sort((a, b) => b.score - a.score);
    storage.set(STORAGE_KEYS.scores, history.slice(0, 50));

    // 2. Then sync.
    if (runToken) {
      const response = await this._request('/api/run/submit', {
        method: 'POST',
        body: {
          runToken,
          score: result.score,
          coins: result.coins,
          distance: result.distance,
          durationMs: result.durationMs,
          bestCombo: result.bestCombo,
        },
      });
      if (response && response.ok && response.player) {
        this._cacheProfile(response.player);
        return {
          profile: response.player,
          accepted: response.accepted,
          personalBest: response.personalBest,
          coinsBanked: response.coinsBanked,
          reasons: response.reasons || [],
        };
      }
    }

    return {
      profile: local,
      accepted: true,
      personalBest: personalBestLocal,
      coinsBanked: banked,
      reasons: [],
      offline: true,
    };
  }

  // -------------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------------

  async leaderboard(window = 'all', limit = 20) {
    const response = await this._request(
      `/api/leaderboard?window=${encodeURIComponent(window)}&limit=${limit}`,
      { auth: false },
    );
    if (response && response.ok) return response.entries || [];

    // Offline: rank the local history.
    const local = this._localScores();
    return local.slice(0, limit).map((entry, index) => ({
      rank: index + 1,
      name: entry.name || 'YOU',
      score: entry.score,
      distance: entry.distance,
      createdMs: entry.createdMs,
      mine: true,
    }));
  }

  // -------------------------------------------------------------------------
  // Profile & shop
  // -------------------------------------------------------------------------

  async setName(name) {
    const clean = String(name || '').trim().slice(0, 16).toUpperCase() || 'RUNNER';
    this._saveLocal((profile) => { profile.name = clean; });

    const response = await this._request('/api/me/name', {
      method: 'POST', body: { name: clean },
    });
    if (response && response.ok && response.player) {
      this._cacheProfile(response.player);
      return response.player;
    }
    return this._localProfile();
  }

  /**
   * Buy the next tier of a shop item.
   * Offline purchases are applied locally against the mirrored catalog.
   */
  async buy(itemId) {
    const response = await this._request('/api/shop/buy', {
      method: 'POST', body: { itemId },
    });

    if (response && response.player) {
      if (response.ok) this._cacheProfile(response.player);
      return {
        ok: !!response.ok,
        error: response.error,
        profile: response.player,
      };
    }

    // --- offline path ---
    const item = this.shop.find((entry) => entry.id === itemId);
    if (!item) return { ok: false, error: 'unknown_item', profile: this._localProfile() };

    const profile = this._localProfile();
    const level = profile.upgrades[itemId] || 0;
    const isConsumable = item.levels === 0;

    if (!isConsumable && level >= item.levels) {
      return { ok: false, error: 'max_level', profile };
    }
    if (isConsumable && level >= (item.max_stock || 9)) {
      return { ok: false, error: 'stock_full', profile };
    }

    const price = priceFor(item, level);
    if (profile.coins < price) {
      return { ok: false, error: 'insufficient_coins', profile };
    }

    const updated = this._saveLocal((p) => {
      p.coins -= price;
      p.upgrades[itemId] = (p.upgrades[itemId] || 0) + 1;
    });
    return { ok: true, profile: updated };
  }

  async buySkin(skinId) {
    const response = await this._request('/api/shop/skin', {
      method: 'POST', body: { skinId },
    });

    if (response && response.player) {
      if (response.ok) this._cacheProfile(response.player);
      return { ok: !!response.ok, error: response.error, profile: response.player };
    }

    const skin = this.skins.find((entry) => entry.id === skinId);
    if (!skin) return { ok: false, error: 'unknown_skin', profile: this._localProfile() };

    const profile = this._localProfile();
    if (profile.ownedSkins.includes(skinId)) {
      const equipped = this._saveLocal((p) => { p.skin = skinId; });
      return { ok: true, profile: equipped };
    }
    if (profile.coins < skin.price) {
      return { ok: false, error: 'insufficient_coins', profile };
    }
    const updated = this._saveLocal((p) => {
      p.coins -= skin.price;
      p.ownedSkins.push(skinId);
      p.skin = skinId;
    });
    return { ok: true, profile: updated };
  }

  async equipSkin(skinId) {
    this._saveLocal((profile) => { profile.skin = skinId; });
    const response = await this._request('/api/me/skin', {
      method: 'POST', body: { skinId },
    });
    if (response && response.ok && response.player) {
      this._cacheProfile(response.player);
      return response.player;
    }
    return this._localProfile();
  }

  /** Consume a hoverboard after a save. */
  async consume(itemId, count = 1) {
    this._saveLocal((profile) => {
      profile.upgrades[itemId] = Math.max(0, (profile.upgrades[itemId] || 0) - count);
    });
    await this._request('/api/shop/consume', {
      method: 'POST', body: { itemId, count },
    });
    return this._localProfile();
  }

  /**
   * Set a consumable to an exact remaining count.
   *
   * Preferred over `consume` when the caller already knows the post-spend
   * total: assigning is idempotent, so a duplicated event cannot burn a second
   * item. The local mirror is written synchronously before the request so the
   * spend survives an immediate reload; the server is then told the delta,
   * since its endpoint is decrement-based.
   */
  async setConsumable(itemId, remaining) {
    const left = Math.max(0, Math.floor(remaining));
    let delta = 0;

    this._saveLocal((profile) => {
      const owned = profile.upgrades[itemId] || 0;
      delta = Math.max(0, owned - left);
      profile.upgrades[itemId] = left;
    });

    if (delta > 0) {
      const response = await this._request('/api/shop/consume', {
        method: 'POST', body: { itemId, count: delta },
      });
      if (response && response.ok && response.player) this._cacheProfile(response.player);
    }
    return this._localProfile();
  }

  /** Persist the opaque progress blob (missions, tutorial flags). */
  async saveProgress(progress) {
    this._saveLocal((profile) => { profile.progress = progress; });
    await this._request('/api/me/progress', { method: 'POST', body: { progress } });
  }
}

/** Shared singleton. Same-origin by default, so it just works when served. */
export const api = new ApiClient('');
