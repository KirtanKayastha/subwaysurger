/**
 * React UI components.
 *
 * No JSX and no build step: `h` is `React.createElement`. React is vendored as
 * a UMD global, so this file works when served directly with zero tooling.
 *
 * Architectural rule: **React never drives the game loop.** The canvas renders
 * itself at whatever rate the display allows; these components only read a HUD
 * snapshot on a rAF tick and render menus. That separation is why heavy UI
 * (shop lists, leaderboards) cannot cause frame drops during play.
 */

import { POWER_DEFS } from '../engine/constants.js';
import { formatCompact, formatDistance, formatNumber } from '../engine/util.js';
import { priceFor } from '../api.js';
import { xpForLevel } from '../missions.js';

const { createElement: h, useState, useEffect, useRef, useCallback, memo } = React;

// ===========================================================================
// HUD
// ===========================================================================

/** Icon glyphs for shop entries (kept as text to avoid any asset loading). */
const ICONS = {
  magnet: 'M', shield: 'S', turbo: '>', coin: 'C',
  rocket: '^', combo: '*', board: '=',
};

/**
 * In-run heads-up display.
 *
 * Receives an immutable snapshot each animation frame. Every value is
 * pre-computed by the engine so this component stays a pure formatter.
 */
export const Hud = memo(function Hud({ hud, best, name }) {
  const scoreRef = useRef(null);
  const lastScore = useRef(0);

  // Pop the score when a big chunk lands (power-up, near-miss, combo tier).
  useEffect(() => {
    const node = scoreRef.current;
    if (!node) return;
    if (hud.score - lastScore.current > 80) {
      node.classList.remove('is-pop');
      // Force reflow so the animation can restart immediately.
      void node.offsetWidth;
      node.classList.add('is-pop');
    }
    lastScore.current = hud.score;
  }, [hud.score]);

  const activePowers = Object.entries(hud.powers || {})
    .filter(([, remaining]) => remaining > 0);

  return h('div', { className: 'hud' },
    h('div', { className: 'hud__top' },
      h('div', { className: 'hud__left' },
        name ? h('div', { className: 'hud__who' }, 'PLAYING AS ', h('b', null, name)) : null,
        h('div', { className: 'hud__score', ref: scoreRef }, formatNumber(hud.score)),
        h('div', { className: 'hud__sub' },
          h('span', null, formatDistance(hud.distance)),
          best > 0 ? h('span', { className: 'hud__best' }, `BEST ${formatCompact(best)}`) : null,
        ),
        hud.combo > 0
          ? h('div', { className: 'combo' },
              h('div', { className: 'combo__label' }, `x${hud.multiplier} - ${hud.combo} CHAIN`),
              h('div', { className: 'combo__bar' },
                h('div', {
                  className: 'combo__fill',
                  style: { width: `${Math.round(hud.comboRatio * 100)}%` },
                }),
              ),
            )
          : null,
      ),

      h('div', { className: 'hud__right' },
        h('div', null,
          h('div', { className: 'hud__coins' },
            h('span', { className: 'coin-dot' }),
            formatNumber(hud.coins),
          ),
          h('div', { className: 'powers', style: { marginTop: '10px' } },
            activePowers.map(([kind, remaining]) => {
              const def = POWER_DEFS[kind];
              const max = (hud.powerMax && hud.powerMax[kind]) || def.duration;
              const pct = Math.max(0, Math.min(100, (remaining / max) * 100));
              return h('div', {
                key: kind,
                className: `power power--${kind}${remaining < 1.6 ? ' is-ending' : ''}`,
              },
                h('span', {
                  className: 'power__ring',
                  style: { '--pct': pct },
                }),
                def.label,
              );
            }),
          ),
        ),
      ),
    ),

    h('div', { className: 'hud__bottom' },
      h('div', { className: 'readout' },
        h('div', null, 'SPEED', h('b', null, `${Math.round(hud.speed * 3.6)} km/h`)),
        hud.hoverboards > 0
          ? h('div', null, 'BOARDS', h('b', null, hud.hoverboards))
          : null,
      ),
      h('button', {
        className: 'btn btn--icon',
        onClick: (event) => { event.currentTarget.blur(); },
        style: { visibility: 'hidden' },
      }, ''),
    ),
  );
});

// ===========================================================================
// Name gate (first launch)
// ===========================================================================

/**
 * First-launch screen: pick a name and a password, then play.
 *
 * One form covers both cases. The name is probed as the player leaves the
 * field, which tells us whether they are claiming a new name or returning to
 * one; the password field relabels itself accordingly. Claiming with an empty
 * password is allowed, returning to a protected name is not.
 *
 * `onClaim(name, password, existing)` resolves `{ ok, error }`.
 */
export function NameGate({ onClaim, onProbe, online }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // null = not yet probed, true = name already exists, false = free.
  const [existing, setExisting] = useState(null);
  const [locked, setLocked] = useState(false);

  const clean = name.trim().toUpperCase().slice(0, 16);
  const validName = clean.length >= 2;
  // A protected name cannot be entered without its password.
  const needsPassword = existing === true && locked;
  const validPassword = !needsPassword || password.length >= 4;
  const canSubmit = validName && validPassword && !busy;

  const probe = async () => {
    if (!validName || !onProbe) return;
    const result = await onProbe(clean);
    if (!result.ok) return;
    setExisting(!result.available);
    setLocked(!!result.hasPassword);
  };

  const submit = async (event) => {
    if (event) event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');

    // Probed state decides the endpoint. When the probe never ran (offline,
    // or the player hit enter immediately) treat it as a claim and let the
    // server correct us via name_taken.
    const outcome = await onClaim(clean, password, existing === true);

    if (!outcome.ok) {
      if (outcome.error === 'invalid_password') {
        setError('INVALID PASSWORD');
        setExisting(true);
        setLocked(true);
      } else if (outcome.error === 'name_taken') {
        // Claim raced with someone else, or the probe was stale. Switch the
        // form to sign-in rather than making the player retype the name.
        setError('THAT NAME IS TAKEN - ENTER ITS PASSWORD OR PICK ANOTHER');
        setExisting(true);
        setLocked(true);
      } else if (outcome.error === 'password_too_short') {
        setError('PASSWORD MUST BE AT LEAST 4 CHARACTERS');
      } else {
        setError('COULD NOT START - TRY AGAIN');
      }
      setBusy(false);
    }
    // On success the screen unmounts.
  };

  const passwordLabel = existing === true
    ? 'PASSWORD'
    : 'PASSWORD (OPTIONAL)';

  return h('div', { className: 'overlay' },
    h('form', { className: 'panel overlay__card', onSubmit: submit },
      h('h1', { className: 'title' }, 'NEON RUSH'),
      h('p', { className: 'title__sub' }, 'ENDLESS SUBWAY RUNNER'),

      h('p', { className: 'gate__prompt' },
        existing === true ? 'WELCOME BACK' : 'CHOOSE YOUR NAME'),

      h('div', { className: 'field field--gate' },
        h('input', {
          value: name,
          autoFocus: true,
          maxLength: 16,
          disabled: busy,
          placeholder: 'USERNAME',
          'aria-label': 'Username',
          autoComplete: 'username',
          autoCorrect: 'off',
          spellCheck: false,
          onChange: (event) => {
            setName(event.target.value);
            setError('');
            // Any edit invalidates the previous probe.
            setExisting(null);
            setLocked(false);
          },
          onBlur: probe,
        }),
      ),

      h('div', { className: 'field field--gate' },
        h('input', {
          value: password,
          type: 'password',
          maxLength: 72,
          disabled: busy,
          placeholder: passwordLabel,
          'aria-label': passwordLabel,
          autoComplete: existing === true ? 'current-password' : 'new-password',
          onChange: (event) => { setPassword(event.target.value); setError(''); },
        }),
      ),

      error
        ? h('div', { className: 'badge badge--warn', style: { marginBottom: '10px' } }, error)
        : null,

      h('div', { className: 'actions' },
        h('button', {
          className: 'btn btn--primary',
          type: 'submit',
          disabled: !canSubmit,
        }, busy ? (existing === true ? 'SIGNING IN...' : 'STARTING...')
                : (existing === true ? 'SIGN IN' : 'START')),
      ),

      h('p', { className: 'gate__note' },
        !validName ? 'AT LEAST 2 CHARACTERS'
          : needsPassword ? 'THIS NAME IS PROTECTED - ENTER ITS PASSWORD'
          : existing === true ? 'SIGNING BACK IN TO THIS NAME'
          : 'A PASSWORD KEEPS THIS NAME YOURS'),

      !online
        ? h('p', { className: 'gate__note' }, 'OFFLINE - SAVED ON THIS DEVICE')
        : null,
    ),
  );
}

// ===========================================================================
// Toasts
// ===========================================================================

export function Toasts({ items }) {
  if (!items.length) return null;
  return h('div', { className: 'toasts' },
    items.map((toast) =>
      h('div', {
        key: toast.id,
        className: `toast${toast.tone ? ` toast--${toast.tone}` : ''}`,
      }, toast.text),
    ),
  );
}

// ===========================================================================
// Countdown
// ===========================================================================

export function Countdown({ value }) {
  if (value <= 0) return null;
  return h('div', { className: 'countdown' },
    h('span', { key: value }, value > 0 ? value : 'GO'),
  );
}

// ===========================================================================
// Shared bits
// ===========================================================================

function Wallet({ coins }) {
  return h('div', { className: 'wallet' },
    h('span', { className: 'coin-dot' }),
    formatNumber(coins),
  );
}

function Tabs({ tabs, active, onChange }) {
  return h('div', { className: 'tabs' },
    tabs.map((tab) =>
      h('button', {
        key: tab.id,
        className: `tab${active === tab.id ? ' is-active' : ''}`,
        onClick: () => onChange(tab.id),
      }, tab.label),
    ),
  );
}

// ===========================================================================
// Main menu
// ===========================================================================

export function MainMenu({
  profile, progress, onPlay, onShop, onLeaderboard, onRename,
  soundOn, musicOn, onToggleSound, onToggleMusic, online, nameNotice,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.name || 'RUNNER');

  const commit = () => {
    setEditing(false);
    const clean = draft.trim().toUpperCase().slice(0, 16);
    if (clean && clean !== profile.name) onRename(clean);
    else setDraft(profile.name);
  };

  const xpNeeded = xpForLevel(progress.level);

  return h('div', { className: 'overlay' },
    h('div', { className: 'panel overlay__card' },
      h('h1', { className: 'title' }, 'NEON RUSH'),
      h('p', { className: 'title__sub' }, 'ENDLESS SUBWAY RUNNER'),

      // --- identity ---
      editing
        ? h('div', { className: 'field' },
            h('input', {
              value: draft,
              autoFocus: true,
              maxLength: 16,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') { setEditing(false); setDraft(profile.name); }
              },
              onBlur: commit,
            }),
            h('button', { className: 'btn btn--ghost', onMouseDown: commit }, 'OK'),
          )
        : h('div', { className: 'hud__sub', style: { justifyContent: 'center', marginBottom: '10px' } },
            h('button', {
              className: 'tab',
              style: { flex: 'none', padding: '6px 14px' },
              onClick: () => { setDraft(profile.name); setEditing(true); },
              title: 'Change your name',
            }, `${profile.name}  [edit]`),
          ),

      nameNotice
        ? h('div', { className: 'badge badge--warn', style: { marginBottom: '10px' } }, nameNotice)
        : null,

      // --- stat summary ---
      h('div', { className: 'results' },
        h('div', { className: 'result result--score' },
          h('span', null, 'Best Score'), h('b', null, formatCompact(profile.bestScore))),
        h('div', { className: 'result result--coins' },
          h('span', null, 'Coins'), h('b', null, formatCompact(profile.coins))),
        h('div', { className: 'result' },
          h('span', null, 'Level'), h('b', null, progress.level)),
        h('div', { className: 'result' },
          h('span', null, 'Runs'), h('b', null, formatNumber(profile.runs))),
      ),

      // --- XP bar ---
      h('div', { className: 'mission', style: { marginTop: '10px' } },
        h('div', { className: 'mission__top' },
          h('span', { className: 'mission__name' }, `LEVEL ${progress.level}`),
          h('span', { className: 'mission__reward' }, `${formatNumber(progress.xp)} / ${formatNumber(xpNeeded)} XP`),
        ),
        h('div', { className: 'mission__bar' },
          h('div', {
            className: 'mission__fill',
            style: { width: `${Math.min(100, (progress.xp / xpNeeded) * 100)}%` },
          }),
        ),
      ),

      // --- actions ---
      h('div', { className: 'actions' },
        h('button', { className: 'btn btn--primary', onClick: onPlay, autoFocus: true }, 'PLAY'),
      ),
      h('div', { className: 'actions', style: { marginTop: '10px' } },
        h('button', { className: 'btn btn--ghost', onClick: onShop }, 'SHOP'),
        h('button', { className: 'btn btn--ghost', onClick: onLeaderboard }, 'SCORES'),
        h('button', {
          className: 'btn btn--ghost btn--icon',
          onClick: onToggleSound,
          title: soundOn ? 'Mute sound effects' : 'Unmute sound effects',
          'aria-label': soundOn ? 'Mute sound effects' : 'Unmute sound effects',
        }, soundOn ? 'SFX' : 'off'),
        h('button', {
          className: 'btn btn--ghost btn--icon',
          onClick: onToggleMusic,
          title: musicOn ? 'Turn music off' : 'Turn music on',
          'aria-label': musicOn ? 'Turn music off' : 'Turn music on',
        }, musicOn ? 'MUS' : 'off'),
      ),

      // --- controls ---
      h('div', { className: 'hints' },
        h('div', { className: 'hint' },
          h('kbd', null, '<  >'), h('p', { className: 'desktop-only' }, 'Switch lane'),
          h('p', { className: 'touch-only' }, 'Swipe sideways')),
        h('div', { className: 'hint' },
          h('kbd', null, 'UP'), h('p', { className: 'desktop-only' }, 'Jump'),
          h('p', { className: 'touch-only' }, 'Swipe up / tap')),
        h('div', { className: 'hint' },
          h('kbd', null, 'DOWN'), h('p', { className: 'desktop-only' }, 'Slide'),
          h('p', { className: 'touch-only' }, 'Swipe down')),
        h('div', { className: 'hint' },
          h('kbd', null, 'P'), h('p', null, 'Pause')),
      ),

      !online
        ? h('p', {
            style: { marginTop: '14px', fontSize: '11px', letterSpacing: '.12em', color: 'var(--text-faint)' },
          }, 'OFFLINE - PROGRESS SAVED ON THIS DEVICE')
        : null,
    ),
  );
}

// ===========================================================================
// Pause
// ===========================================================================

export function PauseMenu({ onResume, onRestart, onQuit, hud }) {
  return h('div', { className: 'overlay' },
    h('div', { className: 'panel overlay__card' },
      h('h2', null, 'PAUSED'),
      h('div', { className: 'results' },
        h('div', { className: 'result result--score' },
          h('span', null, 'Score'), h('b', null, formatNumber(hud.score))),
        h('div', { className: 'result result--coins' },
          h('span', null, 'Coins'), h('b', null, formatNumber(hud.coins))),
        h('div', { className: 'result' },
          h('span', null, 'Distance'), h('b', null, formatDistance(hud.distance))),
        h('div', { className: 'result' },
          h('span', null, 'Best Chain'), h('b', null, `x${hud.multiplier}`)),
      ),
      h('div', { className: 'actions' },
        h('button', { className: 'btn btn--primary', onClick: onResume, autoFocus: true }, 'RESUME'),
      ),
      h('div', { className: 'actions', style: { marginTop: '10px' } },
        h('button', { className: 'btn btn--ghost', onClick: onRestart }, 'RESTART'),
        h('button', { className: 'btn btn--ghost', onClick: onQuit }, 'MENU'),
      ),
    ),
  );
}

// ===========================================================================
// Game over
// ===========================================================================

const DEATH_TEXT = {
  barrier: 'Hit a barrier',
  gate: 'Clipped the gate',
  pylon: 'Ran into a pylon',
  train: 'Met a carriage',
  express: 'The express won',
  drone: 'Swatted by a drone',
  gap: 'Fell into the void',
};

export function GameOver({
  result, profile, personalBest, coinsBanked, completedMissions,
  leveledUp, level, onRestart, onMenu, onShop, accepted,
}) {
  return h('div', { className: 'overlay' },
    h('div', { className: 'panel overlay__card' },
      personalBest ? h('div', { className: 'badge' }, 'NEW PERSONAL BEST') : null,
      leveledUp ? h('div', { className: 'badge' }, `LEVEL ${level} REACHED`) : null,

      h('h2', { className: personalBest ? 'is-best' : 'is-dead' },
        personalBest ? 'RECORD RUN' : 'WIPED OUT'),
      h('p', {
        style: { margin: '0 0 4px', color: 'var(--text-dim)', fontSize: '13px', letterSpacing: '.1em' },
      }, (DEATH_TEXT[result.cause] || 'Run ended').toUpperCase()),

      h('div', { className: 'results' },
        h('div', { className: 'result result--score' },
          h('span', null, 'Score'), h('b', null, formatNumber(result.score))),
        h('div', { className: 'result result--coins' },
          h('span', null, 'Coins Banked'), h('b', null, `+${formatNumber(coinsBanked)}`)),
        h('div', { className: 'result' },
          h('span', null, 'Distance'), h('b', null, formatDistance(result.distance))),
        h('div', { className: 'result' },
          h('span', null, 'Best Chain'), h('b', null, formatNumber(result.bestCombo))),
      ),

      result.stats && result.stats.nearMisses > 0
        ? h('p', {
            style: { margin: '10px 0 0', fontSize: '12px', letterSpacing: '.1em', color: 'var(--lime)' },
          }, `${result.stats.nearMisses} CLOSE CALLS`)
        : null,

      completedMissions.length
        ? h('div', { className: 'missions', style: { marginTop: '14px' } },
            completedMissions.map((mission) =>
              h('div', { className: 'mission is-done', key: mission.key },
                h('div', { className: 'mission__top' },
                  h('span', { className: 'mission__name' }, `DONE - ${mission.label}`),
                  h('span', { className: 'mission__reward' }, `+${mission.reward}`),
                ),
              ),
            ),
          )
        : null,

      !accepted
        ? h('div', { className: 'badge badge--warn', style: { marginTop: '14px' } },
            'SCORE NOT RANKED')
        : null,

      h('div', { className: 'actions' },
        h('button', { className: 'btn btn--primary', onClick: onRestart, autoFocus: true }, 'RUN AGAIN'),
      ),
      h('div', { className: 'actions', style: { marginTop: '10px' } },
        h('button', { className: 'btn btn--ghost', onClick: onShop }, 'SHOP'),
        h('button', { className: 'btn btn--ghost', onClick: onMenu }, 'MENU'),
      ),
    ),
  );
}

// ===========================================================================
// Shop
// ===========================================================================

export function Shop({ profile, catalog, skins, onBuy, onBuySkin, onEquip, onClose, notice }) {
  const [tab, setTab] = useState('upgrades');

  return h('div', { className: 'overlay' },
    h('div', { className: 'panel overlay__card' },
      h('h2', null, 'SHOP'),
      h(Wallet, { coins: profile.coins }),
      h(Tabs, {
        active: tab,
        onChange: setTab,
        tabs: [
          { id: 'upgrades', label: 'Upgrades' },
          { id: 'skins', label: 'Skins' },
        ],
      }),

      notice
        ? h('div', { className: 'badge badge--warn', style: { marginBottom: '10px' } }, notice)
        : null,

      tab === 'upgrades'
        ? h('div', { className: 'shop-list scroll' },
            catalog.map((item) => {
              const level = profile.upgrades[item.id] || 0;
              const isConsumable = item.levels === 0;
              const maxed = isConsumable
                ? level >= (item.max_stock || 9)
                : level >= item.levels;
              const price = priceFor(item, level);
              const affordable = profile.coins >= price;

              return h('div', {
                key: item.id,
                className: `shop-item${maxed ? ' is-max' : ''}`,
              },
                h('div', { className: 'shop-item__icon' }, ICONS[item.icon] || '*'),
                h('div', { className: 'shop-item__body' },
                  h('div', { className: 'shop-item__name' },
                    item.name,
                    // Consumables always show their stock, including x0, so an
                    // empty inventory is visible rather than implied.
                    isConsumable
                      ? h('span', {
                          style: {
                            color: level > 0 ? 'var(--cyan)' : 'var(--text-faint)',
                          },
                        }, `  x${level}`)
                      : null,
                  ),
                  h('div', { className: 'shop-item__desc' }, item.desc),
                  !isConsumable
                    ? h('div', { className: 'pips' },
                        Array.from({ length: item.levels }, (unused, index) =>
                          h('span', {
                            key: index,
                            className: `pip${index < level ? ' is-on' : ''}`,
                          }),
                        ),
                      )
                    : null,
                ),
                h('div', { className: 'shop-item__buy' },
                  maxed
                    ? h('span', { className: 'price' }, isConsumable ? 'FULL' : 'MAX')
                    : h(React.Fragment, null,
                        h('span', { className: `price${affordable ? '' : ' is-poor'}` },
                          formatNumber(price)),
                        h('button', {
                          className: 'btn btn--ghost',
                          disabled: !affordable,
                          onClick: () => onBuy(item.id),
                        }, 'BUY'),
                      ),
                ),
              );
            }),
          )
        : h('div', { className: 'skin-grid scroll' },
            skins.map((skin) => {
              const owned = profile.ownedSkins.includes(skin.id);
              const equipped = profile.skin === skin.id;
              const affordable = profile.coins >= skin.price;

              return h('button', {
                key: skin.id,
                className: `skin${equipped ? ' is-equipped' : ''}${owned ? '' : ' is-locked'}`,
                onClick: () => (owned ? onEquip(skin.id) : (affordable && onBuySkin(skin.id))),
                disabled: !owned && !affordable,
              },
                h('div', {
                  className: 'skin__swatch',
                  style: {
                    background: `linear-gradient(140deg, ${skin.colors[0]}, ${skin.colors[1]})`,
                  },
                }),
                h('div', { className: 'skin__name' }, skin.name),
                h('div', { className: 'skin__meta' },
                  equipped ? 'EQUIPPED' : owned ? 'TAP TO WEAR' : formatNumber(skin.price)),
              );
            }),
          ),

      h('div', { className: 'actions' },
        h('button', { className: 'btn', onClick: onClose }, 'BACK'),
      ),
    ),
  );
}

// ===========================================================================
// Leaderboard
// ===========================================================================

export function Leaderboard({ entries, loading, window: scope, onScope, onClose, profile, missions }) {
  const [tab, setTab] = useState('board');

  return h('div', { className: 'overlay' },
    h('div', { className: 'panel overlay__card' },
      h('h2', null, tab === 'board' ? 'LEADERBOARD' : 'MISSIONS'),
      h(Tabs, {
        active: tab,
        onChange: setTab,
        tabs: [
          { id: 'board', label: 'Scores' },
          { id: 'missions', label: 'Missions' },
        ],
      }),

      tab === 'board'
        ? h(React.Fragment, null,
            h(Tabs, {
              active: scope,
              onChange: onScope,
              tabs: [
                { id: 'all', label: 'All time' },
                { id: 'week', label: 'Week' },
                { id: 'day', label: 'Today' },
              ],
            }),
            loading
              ? h('div', { className: 'empty' }, 'LOADING...')
              : entries.length === 0
                ? h('div', { className: 'empty' }, 'NO RUNS YET - BE THE FIRST')
                : h('div', { className: 'board scroll' },
                    entries.map((entry) =>
                      h('div', {
                        key: `${entry.rank}-${entry.name}-${entry.createdMs}`,
                        className: `board__row${entry.name === profile.name ? ' is-me' : ''}`,
                      },
                        h('span', { className: 'board__rank' }, `#${entry.rank}`),
                        h('div', null,
                          h('div', { className: 'board__name' }, entry.name),
                          h('div', { className: 'board__dist' }, formatDistance(entry.distance)),
                        ),
                        h('span', { className: 'board__score' }, formatNumber(entry.score)),
                      ),
                    ),
                  ),
          )
        : h('div', { className: 'missions' },
            missions.map((mission) =>
              h('div', {
                key: mission.key,
                className: `mission${mission.done ? ' is-done' : ''}`,
              },
                h('div', { className: 'mission__top' },
                  h('span', { className: 'mission__name' }, mission.label),
                  h('span', { className: 'mission__reward' }, `+${mission.reward}`),
                ),
                h('div', { className: 'mission__bar' },
                  h('div', {
                    className: 'mission__fill',
                    style: {
                      width: `${Math.min(100, (mission.progress / mission.target) * 100)}%`,
                    },
                  }),
                ),
              ),
            ),
          ),

      h('div', { className: 'actions' },
        h('button', { className: 'btn', onClick: onClose }, 'BACK'),
      ),
    ),
  );
}
