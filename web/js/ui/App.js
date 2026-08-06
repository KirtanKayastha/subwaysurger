/**
 * Root React component.
 *
 * Owns screen routing, the profile/progression state, and the bridge between
 * game events and UI feedback. The canvas and the `Game` instance are created
 * once and never re-created, so React re-renders cannot disturb the run.
 */

import { api } from '../api.js';
import { audio } from '../engine/audio.js';
import { STORAGE_KEYS } from '../engine/constants.js';
import { Game, STATE } from '../engine/game.js';
import { input } from '../engine/input.js';
import { storage } from '../engine/util.js';
import { applyRun, blankProgress, loadProgress } from '../missions.js';
import {
  Countdown, GameOver, Hud, Leaderboard, MainMenu, PauseMenu, Shop, Toasts,
} from './components.js';

const { createElement: h, useState, useEffect, useRef, useCallback } = React;

/** UI screens (distinct from engine states). */
const SCREEN = {
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
  SHOP: 'shop',
  BOARD: 'board',
};

let toastSeq = 0;

export function App() {
  const [screen, setScreen] = useState(SCREEN.LOADING);
  const [profile, setProfile] = useState(null);
  const [progress, setProgress] = useState(() => blankProgress());
  const [hud, setHud] = useState({ score: 0, coins: 0, distance: 0, powers: {} });
  const [toasts, setToasts] = useState([]);
  const [countdown, setCountdown] = useState(0);
  const [online, setOnline] = useState(false);
  const [settings, setSettings] = useState(() =>
    storage.get(STORAGE_KEYS.settings, { sound: true, music: false }));

  const [runResult, setRunResult] = useState(null);
  const [board, setBoard] = useState({ entries: [], loading: false, window: 'all' });
  const [shopNotice, setShopNotice] = useState('');

  const gameRef = useRef(null);
  const canvasRef = useRef(null);
  const runTokenRef = useRef(null);
  // Screen is read inside event handlers registered once; a ref avoids stale
  // closures without re-subscribing on every render.
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------

  const toast = useCallback((text, tone = '', ttl = 1900) => {
    const id = ++toastSeq;
    setToasts((current) => [...current.slice(-3), { id, text, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, ttl);
  }, []);

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    // The canvas is declared in index.html rather than rendered by React, so
    // that a React re-render can never remount it and destroy the WebGL-free
    // 2D context mid-run.
    canvasRef.current = document.getElementById('game');

    (async () => {
      // Connect (or fall back to local storage) and load progression.
      const loaded = await api.init();
      if (cancelled) return;

      setProfile(loaded);
      setOnline(api.online);
      setProgress(loadProgress(loaded.progress));

      api.onStatusChange = (value) => setOnline(value);

      // Create the engine once the canvas exists.
      const game = new Game(canvasRef.current, handleGameEvent);
      gameRef.current = game;
      // Expose the instance for debugging and the automated smoke test. Read
      // only - nothing in the game reads this back.
      window.__game = game;
      game.applyUpgrades(loaded.upgrades || {}, api.shop);
      game.setSkin(loaded.skin || 'cyan');
      game.renderer.resize();
      game.run();

      // Wire input to the canvas and unlock audio on the first gesture.
      input.attach(canvasRef.current);
      input.onAnyInput = () => {
        if (!audio.unlocked) {
          audio.unlock();
          audio.setEnabled(settings.sound);
          audio.setMusicEnabled(settings.music);
        }
      };
      input.onMute = () => toggleSound();

      setScreen(SCREEN.MENU);
    })();

    return () => {
      cancelled = true;
      input.detach();
      if (gameRef.current) gameRef.current.destroy();
    };
    // Intentionally run once: the engine must not be rebuilt on state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Pump the HUD from the render loop.
   *
   * Reading the engine snapshot on our own rAF (instead of the engine calling
   * setState) means React updates at most once per frame and never blocks the
   * simulation.
   */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const game = gameRef.current;
      if (!game) return;
      if (game.state === STATE.PLAYING || game.state === STATE.COUNTDOWN) {
        setHud(game.hud);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // -------------------------------------------------------------------------
  // Game events
  // -------------------------------------------------------------------------

  function handleGameEvent(event, payload) {
    switch (event) {
      case 'countdown':
        setCountdown(payload);
        break;
      case 'go':
        setCountdown(0);
        break;
      case 'pause':
        setScreen(SCREEN.PAUSED);
        break;
      case 'resume':
        setScreen(SCREEN.PLAYING);
        break;
      case 'power':
        toast(`${payload.kind.toUpperCase()} ACTIVE`, 'lime');
        break;
      case 'shieldBreak':
        toast('SHIELD DOWN', 'warn');
        break;
      case 'hoverboardUsed':
        // The engine has already spent the board and mirrored the new count to
        // its own inventory. Commit the same spend to the profile so the shop
        // and the next run agree; without this, `applyUpgrades()` would restore
        // the board from the stale profile on the following run.
        commitHoverboardSpend(payload);
        toast(`HOVERBOARD SAVE - ${payload} LEFT`, 'gold', 2400);
        break;
      case 'comboUp':
        toast(`x${payload} MULTIPLIER`, 'lime', 1200);
        break;
      case 'gameover':
        finishRun(payload);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  /**
   * Record a spent hoverboard against the profile.
   *
   * `remaining` is the authoritative post-spend count from the engine, so this
   * assigns rather than decrements: replaying the same event can never take a
   * second board. The localStorage write inside `api.consume` is synchronous,
   * so the spend survives an immediate reload.
   */
  function commitHoverboardSpend(remaining) {
    const left = Math.max(0, Math.floor(remaining));
    setProfile((current) => (current
      ? { ...current, upgrades: { ...current.upgrades, hoverboard: left } }
      : current));
    api.setConsumable('hoverboard', left);
  }

  const startRun = useCallback(async () => {
    const game = gameRef.current;
    if (!game || !profile) return;

    audio.unlock();
    audio.setEnabled(settings.sound);
    audio.setMusicEnabled(settings.music);

    setRunResult(null);
    setScreen(SCREEN.PLAYING);

    // Ask the backend for a run token + seed. Offline, this returns a local
    // seed and a null token, and everything still works.
    const session = await api.startRun();
    runTokenRef.current = session.runToken;

    game.applyUpgrades(profile.upgrades || {}, api.shop);
    game.setSkin(profile.skin || 'cyan');
    // Reconcile the engine's consumable stock with the profile before the run.
    // This is what migrates players who predate the inventory key, and repairs
    // any drift from a run that ended without the spend being committed.
    game.syncInventory({ hoverboard: (profile.upgrades || {}).hoverboard || 0 });
    game.start({ seed: session.seed, skin: profile.skin || 'cyan' });
  }, [profile, settings.sound, settings.music]);

  /** Submit the run, fold in missions, and show the results screen. */
  async function finishRun(result) {
    setRunResult({
      ...result,
      personalBest: false,
      coinsBanked: 0,
      completed: [],
      leveledUp: false,
      accepted: true,
    });
    setScreen(SCREEN.OVER);

    // Missions are computed locally so the screen can populate instantly.
    const missionOutcome = applyRun(progress, result);
    setProgress(missionOutcome.progress);

    const submission = await api.submitRun(result, runTokenRef.current);
    runTokenRef.current = null;

    // Mission rewards are credited on top of the run's banked coins.
    let updated = submission.profile;
    if (missionOutcome.coinsAwarded > 0) {
      updated = {
        ...updated,
        coins: updated.coins + missionOutcome.coinsAwarded,
        totalCoins: updated.totalCoins + missionOutcome.coinsAwarded,
      };
      storage.set(STORAGE_KEYS.profile, updated);
    }

    setProfile(updated);
    api.saveProgress(missionOutcome.progress);

    setRunResult({
      ...result,
      personalBest: submission.personalBest,
      coinsBanked: submission.coinsBanked + missionOutcome.coinsAwarded,
      completed: missionOutcome.completed,
      leveledUp: missionOutcome.leveledUp,
      accepted: submission.accepted,
    });

    if (submission.personalBest) audio.fanfare();
    if (missionOutcome.leveledUp) toast(`LEVEL ${missionOutcome.progress.level}`, 'gold', 2600);
  }

  const backToMenu = useCallback(() => {
    const game = gameRef.current;
    if (game) game.quit();
    setScreen(SCREEN.MENU);
    audio.click();
  }, []);

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  const persistSettings = (next) => {
    setSettings(next);
    storage.set(STORAGE_KEYS.settings, next);
  };

  function toggleSound() {
    const next = { ...settings, sound: !settings.sound };
    persistSettings(next);
    audio.unlock();
    audio.setEnabled(next.sound);
    if (next.sound) audio.click();
  }

  function toggleMusic() {
    const next = { ...settings, music: !settings.music };
    persistSettings(next);
    audio.unlock();
    audio.setMusicEnabled(next.music);
    audio.click();
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------

  const buyItem = useCallback(async (itemId) => {
    setShopNotice('');
    const outcome = await api.buy(itemId);
    if (outcome.ok) {
      setProfile(outcome.profile);
      if (gameRef.current) {
        gameRef.current.applyUpgrades(outcome.profile.upgrades || {}, api.shop);
      }
      audio.purchase();
      toast('UPGRADED', 'gold', 1400);
    } else {
      audio.deny();
      setShopNotice(
        outcome.error === 'insufficient_coins' ? 'NOT ENOUGH COINS'
        : outcome.error === 'max_level' ? 'ALREADY MAXED'
        : outcome.error === 'stock_full' ? 'STOCK FULL'
        : 'PURCHASE FAILED',
      );
      if (outcome.profile) setProfile(outcome.profile);
    }
  }, [toast]);

  const buySkin = useCallback(async (skinId) => {
    setShopNotice('');
    const outcome = await api.buySkin(skinId);
    if (outcome.ok) {
      setProfile(outcome.profile);
      if (gameRef.current) gameRef.current.setSkin(outcome.profile.skin);
      audio.purchase();
      toast('SKIN UNLOCKED', 'gold', 1400);
    } else {
      audio.deny();
      setShopNotice(outcome.error === 'insufficient_coins' ? 'NOT ENOUGH COINS' : 'PURCHASE FAILED');
    }
  }, [toast]);

  const equipSkin = useCallback(async (skinId) => {
    const updated = await api.equipSkin(skinId);
    setProfile(updated);
    if (gameRef.current) gameRef.current.setSkin(skinId);
    audio.click();
  }, []);

  const renamePlayer = useCallback(async (name) => {
    const updated = await api.setName(name);
    setProfile(updated);
    audio.click();
  }, []);

  // -------------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------------

  const openBoard = useCallback(async (scope = 'all') => {
    audio.click();
    setScreen(SCREEN.BOARD);
    setBoard((current) => ({ ...current, loading: true, window: scope }));
    const entries = await api.leaderboard(scope, 20);
    setBoard({ entries, loading: false, window: scope });
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (screen === SCREEN.LOADING || !profile) {
    return h('div', { className: 'overlay' },
      h('div', { className: 'panel overlay__card' },
        h('h1', { className: 'title' }, 'NEON RUSH'),
        h('p', { className: 'title__sub' }, 'LOADING'),
      ),
    );
  }

  return h(React.Fragment, null,
    // In-run HUD sits under any overlay.
    (screen === SCREEN.PLAYING || screen === SCREEN.PAUSED)
      ? h(Hud, { hud, best: profile.bestScore })
      : null,

    countdown > 0 && screen === SCREEN.PLAYING
      ? h(Countdown, { value: countdown })
      : null,

    h(Toasts, { items: toasts }),

    screen === SCREEN.MENU
      ? h(MainMenu, {
          profile, progress, online,
          soundOn: settings.sound,
          musicOn: settings.music,
          onPlay: startRun,
          onShop: () => { audio.click(); setShopNotice(''); setScreen(SCREEN.SHOP); },
          onLeaderboard: () => openBoard(board.window),
          onRename: renamePlayer,
          onToggleSound: toggleSound,
          onToggleMusic: toggleMusic,
        })
      : null,

    screen === SCREEN.PAUSED
      ? h(PauseMenu, {
          hud,
          onResume: () => { audio.click(); gameRef.current.resume(); },
          onRestart: () => { audio.click(); startRun(); },
          onQuit: backToMenu,
        })
      : null,

    screen === SCREEN.OVER && runResult
      ? h(GameOver, {
          result: runResult,
          profile,
          personalBest: runResult.personalBest,
          coinsBanked: runResult.coinsBanked,
          completedMissions: runResult.completed || [],
          leveledUp: runResult.leveledUp,
          level: progress.level,
          accepted: runResult.accepted !== false,
          onRestart: () => { audio.click(); startRun(); },
          onMenu: backToMenu,
          onShop: () => { audio.click(); setShopNotice(''); setScreen(SCREEN.SHOP); },
        })
      : null,

    screen === SCREEN.SHOP
      ? h(Shop, {
          profile,
          catalog: api.shop,
          skins: api.skins,
          notice: shopNotice,
          onBuy: buyItem,
          onBuySkin: buySkin,
          onEquip: equipSkin,
          onClose: () => {
            audio.click();
            setShopNotice('');
            setScreen(runResult && gameRef.current.state === STATE.OVER ? SCREEN.OVER : SCREEN.MENU);
          },
        })
      : null,

    screen === SCREEN.BOARD
      ? h(Leaderboard, {
          entries: board.entries,
          loading: board.loading,
          window: board.window,
          missions: progress.missions,
          profile,
          onScope: openBoard,
          onClose: () => { audio.click(); setScreen(SCREEN.MENU); },
        })
      : null,

    !online
      ? h('div', { className: 'conn' }, 'OFFLINE MODE')
      : null,
  );
}

/** Canvas element is rendered outside React (see index.html) and found by id. */
export function mount() {
  const container = document.getElementById('ui-root');
  const root = ReactDOM.createRoot(container);
  root.render(h(App));
}
