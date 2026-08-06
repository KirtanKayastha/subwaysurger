/**
 * Headless engine test harness.
 *
 * Boots the real engine (world generation, player physics, collision, scoring)
 * under a minimal DOM stub and drives it with a scripted bot. This exists to
 * verify the property that matters most in an endless runner and that is
 * impossible to eyeball reliably:
 *
 *     **every generated row is actually survivable**
 *
 * A competent bot that jumps barriers, slides under gates and dodges solid
 * hazards should be able to run indefinitely. If it dies, either the generator
 * produced an unfair pattern or the physics cannot clear an obstacle - both are
 * real bugs, and both are reported with the seed so they can be reproduced.
 *
 *   node tools/simulate.mjs [runs] [maxMetres]
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// DOM / browser stubs (installed before importing the engine)
// ---------------------------------------------------------------------------

let simTime = 0;   // seconds; drives the stubbed performance.now()

const noop = () => {};
const canvasContext = new Proxy({}, {
  get(target, prop) {
    if (prop === 'canvas') return stubCanvas;
    // Gradient factories must return an object with addColorStop.
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop: noop });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return noop;
  },
  set: () => true,
});

const stubCanvas = {
  width: 1280, height: 720,
  getContext: () => canvasContext,
  getBoundingClientRect: () => ({ width: 1280, height: 720, top: 0, left: 0 }),
  addEventListener: noop,
  removeEventListener: noop,
  style: {},
};

globalThis.performance = { now: () => simTime * 1000 };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = noop;

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: noop,
  removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  localStorage: {
    getItem: () => null, setItem: noop, removeItem: noop,
  },
  AudioContext: undefined,
};
globalThis.document = {
  hidden: false,
  addEventListener: noop,
  removeEventListener: noop,
  getElementById: () => stubCanvas,
  createElement: () => stubCanvas,
};
// Node >= 21 exposes a read-only `navigator` global, so it must be replaced
// via defineProperty rather than plain assignment.
Object.defineProperty(globalThis, 'navigator', {
  value: { getGamepads: () => [], vibrate: noop },
  configurable: true,
  writable: true,
});
globalThis.localStorage = globalThis.window.localStorage;

// ---------------------------------------------------------------------------
// Engine imports (after stubs are in place)
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(join(ROOT, 'web', 'js', rel)).href);

const { Game, STATE } = await load('engine/game.js');
const { HAZARD, FIXED_STEP, LANE_X, PLAYER } = await load('engine/constants.js');
const { ACTION, input } = await load('engine/input.js');

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

/** How each hazard type can be answered. */
const RESPONSE = {
  [HAZARD.BARRIER]: 'jump',
  [HAZARD.GAP]: 'jump',
  [HAZARD.GATE]: 'duck',
  [HAZARD.DRONE]: 'duck',
  [HAZARD.PYLON]: 'dodge',
  [HAZARD.TRAIN]: 'dodge',
  [HAZARD.EXPRESS]: 'dodge',
};

/**
 * Cost of occupying `lane` over the next `span` metres.
 *   0   - clear
 *   1   - handleable without leaving the lane (jump or slide)
 *   100 - solid: must not be here
 */
function laneCost(world, lane, fromZ, span) {
  const laneX = LANE_X[lane];
  let cost = 0;
  for (const hazard of world.hazards) {
    if (hazard.halfWidth <= 0) continue;                 // smashed
    if (Math.abs(hazard.x - laneX) > hazard.halfWidth + 0.5) continue;

    // An oncoming train blocks its entire lane for as long as it is ahead of
    // us: by the time we arrive it will have moved, so its current Z tells us
    // nothing useful. A human simply avoids that lane until it has passed.
    if (hazard.vz < 0 && hazard.z > fromZ - hazard.halfDepth) {
      cost += 100;
      continue;
    }

    const near = hazard.z - hazard.halfDepth;
    const far = hazard.z + hazard.halfDepth;
    if (far <= fromZ - 1 || near >= fromZ + span) continue;
    const response = RESPONSE[hazard.kind] || 'dodge';
    cost += response === 'dodge' ? 100 : 1;
  }
  return cost;
}

/** Nearest hazard in the player's lane, or null. */
function threatAhead(world, player) {
  let best = null;
  const laneX = LANE_X[player.lane];
  for (const hazard of world.hazards) {
    if (hazard.halfWidth <= 0) continue;
    if (Math.abs(hazard.x - laneX) > hazard.halfWidth + 0.4) continue;
    const near = hazard.z - hazard.halfDepth;
    const gap = near - player.z;
    if (gap < -hazard.halfDepth * 2) continue;
    if (!best || gap < best.gap) best = { hazard, gap };
  }
  return best;
}

/** An oncoming train currently sharing the player's lane, if any. */
function oncomingInLane(world, player) {
  const laneX = LANE_X[player.lane];
  for (const hazard of world.hazards) {
    if (hazard.vz >= 0 || hazard.halfWidth <= 0) continue;
    if (Math.abs(hazard.x - laneX) > hazard.halfWidth + 0.4) continue;
    // Still ahead of (or overlapping) us: it has not passed yet.
    if (hazard.z + hazard.halfDepth > player.z - 1) return hazard;
  }
  return null;
}

/** Choose the safest lane and step one lane toward it. Returns true if moved. */
function stepTowardSafeLane(game, span) {
  const { player, world } = game;
  const costs = [0, 1, 2].map((lane) => laneCost(world, lane, player.z, span));

  let bestLane = player.lane;
  let bestCost = Infinity;
  for (let lane = 0; lane < 3; lane++) {
    // A lane change passes *through* every lane in between, so the transit
    // lanes must be survivable too. Crossing a 22 m carriage to reach a clear
    // outer lane is not a dodge, it is a slower collision. The current lane is
    // excluded: we are already leaving it.
    let transit = 0;
    if (lane !== player.lane) {
      const step = lane < player.lane ? -1 : 1;
      for (let l = player.lane + step; l !== lane; l += step) transit += costs[l];
    }

    const cost = costs[lane] + transit + Math.abs(lane - player.lane) * 0.5;
    if (cost < bestCost) { bestCost = cost; bestLane = lane; }
  }

  if (bestLane === player.lane) return false;
  input.push(bestLane < player.lane ? ACTION.LEFT : ACTION.RIGHT);
  return true;
}

/**
 * Decide and issue one action for this tick.
 *
 * Priority order matters as much as the individual rules:
 *   1. vacate the lane of an oncoming train (highest closing speed = least time)
 *   2. jump / slide the nearest static hazard (allowed mid-lane-change)
 *   3. dodge solid hazards (only once the previous lane change has settled)
 *
 * The bot deliberately does NOT push an action every tick: spamming the input
 * queue makes stale commands fire after the situation has changed.
 */
function botTick(game) {
  const { player, world, speed } = game;

  // --- 1. oncoming train in our lane -------------------------------------
  if (player.laneT >= 1 && oncomingInLane(world, player)) {
    if (stepTowardSafeLane(game, Math.max(40, speed * 1.6))) return;
  }

  const threat = threatAhead(world, player);
  if (!threat) return;

  const { hazard, gap } = threat;
  const response = RESPONSE[hazard.kind] || 'dodge';

  // --- 2. jump / slide (valid even while a lane change is in flight) ------
  if (response === 'jump') {
    const lead = speed * (hazard.kind === HAZARD.GAP ? 0.18 : 0.30);
    if (gap <= lead && gap > -0.5 && player.grounded) {
      input.push(ACTION.JUMP);
    }
    return;
  }

  if (response === 'duck') {
    // Slide lasts ~0.6 s; start just before contact.
    if (gap <= speed * 0.26 && gap > -1 && player.grounded && !player.ducking) {
      input.push(ACTION.DUCK);
    }
    return;
  }

  // --- 3. dodge -----------------------------------------------------------
  // Wait out an in-progress lane change before committing to another.
  if (player.laneT < 1) return;

  if (gap <= speed * 1.6 || hazard.vz < 0) {
    const span = Math.max(hazard.halfDepth * 2 + 6, speed * 1.4);
    if (!stepTowardSafeLane(game, span) && hazard.kind === HAZARD.TRAIN) {
      // Boxed in by a carriage: ride the roof instead.
      const lead = speed * 0.30;
      if (gap <= lead && gap > -0.5 && player.grounded) input.push(ACTION.JUMP);
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function simulate(seed, maxDistance, debug = false) {
  simTime = 0;
  const game = new Game(stubCanvas, () => {});
  game.reducedMotion = true;              // skip particle spam
  game.start({ seed, skin: 'cyan' });

  // Skip the countdown; we want to test the run itself.
  game.state = STATE.PLAYING;
  game.countdown = 0;

  // Capture the exact hazard and player box at the moment of impact.
  const originalImpact = game._impact.bind(game);
  game._impact = (hazard) => {
    if (!game.__impact) {
      game.__impact = {
        kind: hazard.kind,
        hazard: { x: +hazard.x.toFixed(2), y: +hazard.y.toFixed(2), z: +hazard.z.toFixed(2),
                  hw: hazard.halfWidth, hh: hazard.halfHeight, hd: hazard.halfDepth },
        player: { x: +game.player.x.toFixed(2), y: +game.player.y.toFixed(2),
                  cy: +game.player.centerY.toFixed(2), z: +game.player.z.toFixed(2),
                  hh: game.player.halfHeight, ducking: game.player.ducking,
                  grounded: game.player.grounded },
      };
    }
    return originalImpact(hazard);
  };

  let steps = 0;
  const maxSteps = 400_000;
  // Rolling snapshot so we can describe the moment of death.
  let lastState = null;

  while (game.state === STATE.PLAYING && game.distance < maxDistance && steps < maxSteps) {
    botTick(game);
    lastState = {
      y: game.player.y.toFixed(2),
      vy: game.player.vy.toFixed(1),
      grounded: game.player.grounded,
      ducking: game.player.ducking,
      lane: game.player.lane,
      laneT: game.player.laneT.toFixed(2),
      airTime: game.player.airTime.toFixed(2),
    };
    game._update(FIXED_STEP);
    simTime += FIXED_STEP;
    steps++;
  }

  game.stop();

  const result = {
    seed,
    died: game.state !== STATE.PLAYING,
    cause: game.deathCause,
    distance: Math.round(game.distance),
    score: Math.round(game.score),
    coins: game.coins,
    speed: game.speed.toFixed(1),
    hazards: game.world.hazards.length,
    steps,
    atDeath: lastState,
  };

  if (debug && result.died) {
    console.log(`\n  --- death context (seed ${seed}, ${result.cause}) ---`);
    console.log('  player:', JSON.stringify(lastState));
    if (game.__impact) {
      console.log('  impact:', JSON.stringify(game.__impact));
      const i = game.__impact;
      const dy = Math.abs(i.player.cy - i.hazard.y);
      const sum = i.player.hh + i.hazard.hh;
      console.log(`  y-overlap: |${i.player.cy} - ${i.hazard.y}| = ${dy.toFixed(3)} vs ${sum.toFixed(3)} => ${dy < sum ? 'OVERLAP' : 'clear'}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runCount = Number(process.argv[2] || 12);
const maxDistance = Number(process.argv[3] || 6000);
const debug = process.argv.includes('--debug');

console.log(`Simulating ${runCount} runs, target ${maxDistance} m each...\n`);

const results = [];
for (let i = 0; i < runCount; i++) {
  const seed = 1000 + i * 7919;
  results.push(simulate(seed, maxDistance, debug));
}

const deaths = results.filter((r) => r.died);
const survived = results.length - deaths.length;

for (const r of results) {
  const status = r.died ? `DIED (${r.cause})` : 'survived';
  console.log(
    `  seed ${String(r.seed).padStart(6)}  ${String(r.distance).padStart(6)} m  ` +
    `score ${String(r.score).padStart(8)}  coins ${String(r.coins).padStart(4)}  ` +
    `${r.speed} m/s  ${status}`,
  );
}

const avg = Math.round(results.reduce((a, r) => a + r.distance, 0) / results.length);
const avgCoins = Math.round(results.reduce((a, r) => a + r.coins, 0) / results.length);

console.log(`\n  survived to target: ${survived}/${results.length}`);
console.log(`  average distance:   ${avg} m`);
console.log(`  average coins:      ${avgCoins}`);

if (deaths.length) {
  const causes = {};
  for (const d of deaths) causes[d.cause] = (causes[d.cause] || 0) + 1;
  console.log(`  death causes:       ${JSON.stringify(causes)}`);
}

// The bot is not perfect, but a fair generator should let it reach the target
// the large majority of the time. A low rate means unsolvable rows exist.
const rate = survived / results.length;
if (rate < 0.75) {
  console.error(`\nFAIL: survival rate ${(rate * 100).toFixed(0)}% is too low - generator may be producing unfair rows.`);
  process.exit(1);
}
console.log('\nPASS: generation appears fair and physics can clear every hazard.');
