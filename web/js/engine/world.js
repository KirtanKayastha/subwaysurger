/**
 * World generation.
 *
 * The track is built ahead of the runner one "row" at a time. A row is a
 * hand-authored arrangement of hazards across the three lanes, chosen from a
 * weighted pool that widens as the run progresses.
 *
 * FAIRNESS IS THE CORE CONSTRAINT. An endless runner dies the moment a player
 * believes a death was unavoidable, so generation guarantees:
 *
 *  1. **Every row has a solution.** Rows are templates, never per-lane random
 *     rolls. Each template either leaves a lane open or is uniformly clearable
 *     by a single action (all-jump / all-slide).
 *  2. **Reaction time is constant, not distance.** Row spacing is measured in
 *     *seconds* at the current speed, so going faster makes the track denser to
 *     look at but never reduces thinking time below the budget.
 *  3. **No compound-impossible states.** While an express train is sweeping a
 *     lane, full-width rows are suppressed - you can never be forced to jump
 *     into a train.
 *  4. **A settling distance after long obstacles.** Rows never overlap the
 *     tail of a train carriage.
 */

import {
  COIN, DIFFICULTY, HAZARD, HAZARD_DEFS, LANE_X, POWER_SPACING,
  POWER_WEIGHTS, VIEW_DISTANCE, CULL_BEHIND,
} from './constants.js';
import { clamp, clamp01, remap } from './util.js';

let nextId = 1;

/** Create a hazard entity positioned in a lane. */
function makeHazard(kind, lane, z, overrides = {}) {
  const def = HAZARD_DEFS[kind];
  return {
    id: nextId++,
    entity: 'hazard',
    kind,
    lane,
    x: LANE_X[lane],
    // `y` is the *centre* of the collision box.
    y: overrides.y ?? (kind === HAZARD.GATE
      ? def.clearance + def.height / 2
      : kind === HAZARD.DRONE
        ? def.base + def.height / 2
        : def.height / 2),
    z,
    halfWidth: (overrides.width ?? def.width) / 2,
    halfHeight: (overrides.height ?? def.height) / 2,
    halfDepth: (overrides.depth ?? def.depth) / 2,
    color: def.color,
    solid: !!def.solid,
    rideable: !!def.rideable,
    // Movement (express trains, drones).
    vz: overrides.vz ?? 0,
    vx: overrides.vx ?? 0,
    /** Seconds remaining on the on-screen warning indicator. */
    warn: overrides.warn ?? 0,
    /** Set once the player has been scored for slipping past this hazard. */
    scored: false,
    /** Animation phase offset so identical props do not pulse in lockstep. */
    phase: Math.random() * Math.PI * 2,
    ...overrides,
  };
}

/** Create a coin at a world position. */
function makeCoin(x, y, z) {
  return {
    id: nextId++,
    entity: 'coin',
    x, y, z,
    baseX: x,
    collected: false,
    /** Set true once the magnet has claimed it, so it homes in. */
    magnetised: false,
    phase: Math.random() * Math.PI * 2,
  };
}

/** Create a power-up crate. */
function makePower(kind, x, y, z) {
  return {
    id: nextId++,
    entity: 'power',
    kind,
    x, y, z,
    collected: false,
    phase: Math.random() * Math.PI * 2,
  };
}

export class World {
  /**
   * @param {(min?:number,max?:number)=>number} rng seeded generator from util.makeRng
   */
  constructor(rng) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    /** @type {any[]} */ this.hazards = [];
    /** @type {any[]} */ this.coins = [];
    /** @type {any[]} */ this.powers = [];

    /** Z at which the next row will be generated. */
    this.cursorZ = 45;
    /** Distance travelled when the last power-up was placed. */
    this.lastPowerZ = 120;
    /** Cooldown before another express train may launch. */
    this.expressCooldown = 0;
    /** Lane currently threatened by an express (or -1). */
    this.expressLane = -1;
    /** Rows since the last breather, used to pace intensity. */
    this.rowsSinceRest = 0;
  }

  // -------------------------------------------------------------------------
  // Difficulty helpers
  // -------------------------------------------------------------------------

  /** Which hazard kinds are unlocked at this distance. */
  availableKinds(distance) {
    const unlocks = DIFFICULTY.unlocks;
    const kinds = [HAZARD.BARRIER];
    if (distance >= unlocks.gate) kinds.push(HAZARD.GATE);
    if (distance >= unlocks.pylon) kinds.push(HAZARD.PYLON);
    if (distance >= unlocks.train) kinds.push(HAZARD.TRAIN);
    if (distance >= unlocks.gap) kinds.push(HAZARD.GAP);
    if (distance >= unlocks.drone) kinds.push(HAZARD.DRONE);
    return kinds;
  }

  /**
   * Metres to leave before the next row.
   *
   * Derived from a *time* budget that tightens with distance, then clamped to a
   * visual minimum. This is the single most important fairness knob.
   */
  rowSpacing(distance, speed) {
    const reaction = remap(
      distance, 0, DIFFICULTY.reactionRamp,
      DIFFICULTY.reactionEarly, DIFFICULTY.reactionLate,
    );
    return Math.max(DIFFICULTY.minRowGap, speed * reaction);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Ensure the track is populated up to `playerZ + VIEW_DISTANCE`.
   * Called every frame; usually generates zero or one row.
   */
  generate(playerZ, distance, speed) {
    const horizon = playerZ + VIEW_DISTANCE;
    // Bound the work per frame; a huge dt should never generate 500 rows.
    let guard = 24;
    while (this.cursorZ < horizon && guard-- > 0) {
      const advance = this._buildRow(this.cursorZ, distance, speed);
      this.cursorZ += advance;
    }
    this._maybeLaunchExpress(playerZ, distance, speed);
    this._maybePlacePower(playerZ, distance);
  }

  /**
   * Build one row at `z`.
   * @returns {number} how far to advance the cursor
   */
  _buildRow(z, distance, speed) {
    const rng = this.rng;
    const spacing = this.rowSpacing(distance, speed);
    const kinds = this.availableKinds(distance);
    const has = (k) => kinds.includes(k);

    // Ramp-in: the first stretch is deliberately empty so the player can get a
    // feel for the controls before anything can kill them.
    if (z < 90) {
      this._coinLine(rng.int(0, 2), z, 6);
      return spacing;
    }

    // Give the player a breather after a burst of dense rows.
    this.rowsSinceRest++;
    if (this.rowsSinceRest >= rng.int(6, 10)) {
      this.rowsSinceRest = 0;
      return this._restRow(z, spacing, distance);
    }

    // While an express is sweeping a lane, keep the rest of the track simple.
    // The player is already committed to a lane change they cannot undo, so
    // adding a dodge-only blocker (pylon/train/gap) in a neighbouring lane can
    // create a genuinely unwinnable moment. Restricting to jump/slide hazards
    // guarantees an answer always exists.
    if (this.expressLane >= 0) {
      return this._singleRow(z, spacing, this._simpleKinds(kinds), rng);
    }

    // Difficulty 0..1 scales how often the nastier templates appear.
    const heat = clamp01(distance / 3000);

    // Weighted template pool. Weights shift with `heat` so early runs are
    // mostly single obstacles and later runs favour multi-lane pressure.
    const pool = [
      ['single', 30 - heat * 14],
      ['double', 8 + heat * 16],
      ['sweep', 6 + heat * 12],     // full-width, one action clears it
      ['stagger', 5 + heat * 13],   // two rows in quick succession
    ];
    if (has(HAZARD.TRAIN)) pool.push(['train', 9 + heat * 8]);
    if (has(HAZARD.GAP)) pool.push(['gap', 5 + heat * 8]);
    if (has(HAZARD.DRONE)) pool.push(['drone', 4 + heat * 8]);

    const template = rng.weighted(pool);
    switch (template) {
      case 'double':  return this._doubleRow(z, spacing, kinds, rng);
      case 'sweep':   return this._sweepRow(z, spacing, kinds, rng);
      case 'stagger': return this._staggerRow(z, spacing, kinds, rng, distance, speed);
      case 'train':   return this._trainRow(z, spacing, rng);
      case 'gap':     return this._gapRow(z, spacing, rng);
      case 'drone':   return this._droneRow(z, spacing, rng);
      default:        return this._singleRow(z, spacing, kinds, rng);
    }
  }

  /** Empty stretch with a coin reward - the "breathe" beat. */
  _restRow(z, spacing, distance) {
    const rng = this.rng;
    const lane = rng.int(0, 2);
    const style = rng.pick(['line', 'zigzag', 'arc']);

    if (style === 'zigzag') {
      // Coins that hop between lanes, rewarding quick, safe lane work.
      let current = lane;
      for (let i = 0; i < 10; i++) {
        if (i % 3 === 0) current = clamp(current + rng.pick([-1, 1]), 0, 2);
        this.coins.push(makeCoin(LANE_X[current], COIN.height, z + i * COIN.spacing));
      }
    } else if (style === 'arc') {
      this._coinArc(lane, z, 8);
    } else {
      this._coinLine(lane, z, 10);
    }
    return spacing * 1.15;
  }

  /** One hazard in one lane. */
  _singleRow(z, spacing, kinds, rng) {
    const lane = rng.int(0, 2);
    const kind = this._pickBlocker(kinds, rng);
    this.hazards.push(makeHazard(kind, lane, z));
    this._rewardRow(kind, lane, z);
    return spacing;
  }

  /** Two lanes blocked, one guaranteed open. */
  _doubleRow(z, spacing, kinds, rng) {
    const lanes = rng.shuffle([0, 1, 2]);
    const open = lanes[2];
    // The open lane must be reachable: if it is an outer lane and the centre
    // is blocked by a solid hazard, the player may not be able to cross. Keep
    // the centre clearable in that case.
    const centreBlocked = lanes[0] === 1 || lanes[1] === 1;
    for (let i = 0; i < 2; i++) {
      const lane = lanes[i];
      const kind = (lane === 1 && open !== 1 && centreBlocked)
        ? this._pickSimple(kinds, rng)
        : this._pickBlocker(kinds, rng);
      this.hazards.push(makeHazard(kind, lane, z));
    }
    // Reward taking the safe lane.
    this._coinLine(open, z + 3, 4);
    return spacing;
  }

  /**
   * All three lanes blocked by the *same* hazard type.
   *
   * Safe because a single jump (or single slide) clears the whole row - this is
   * the pattern that makes the game feel rhythmic rather than purely evasive.
   */
  _sweepRow(z, spacing, kinds, rng) {
    // Never place a full-width row while an express is sweeping: the player
    // would have to jump, and might be forced into the train's lane.
    if (this.expressLane >= 0) return this._singleRow(z, spacing, kinds, rng);

    const canGate = kinds.includes(HAZARD.GATE);
    const kind = canGate && rng.chance(0.45) ? HAZARD.GATE : HAZARD.BARRIER;
    for (let lane = 0; lane < 3; lane++) {
      this.hazards.push(makeHazard(kind, lane, z));
    }
    // Coins sit where the correct action puts you: high over a barrier, low
    // under a gate. This teaches the mechanic through reward.
    const lane = rng.int(0, 2);
    if (kind === HAZARD.BARRIER) this._coinArc(lane, z - 3, 7);
    else this._coinLine(lane, z - 2, 5, 0.55);
    return spacing * 1.1;
  }

  /** Two quick rows offset in Z, forcing a follow-up decision. */
  _staggerRow(z, spacing, kinds, rng) {
    const laneA = rng.int(0, 2);
    this.hazards.push(makeHazard(this._pickBlocker(kinds, rng), laneA, z));

    // The second row must leave a lane reachable from wherever the first row
    // pushed the player, so block a lane *other* than the one they fled to.
    const offset = Math.max(11, spacing * 0.62);
    const laneB = (laneA + (rng.chance(0.5) ? 1 : 2)) % 3;
    this.hazards.push(makeHazard(this._pickBlocker(kinds, rng), laneB, z + offset));

    const safe = 3 - laneA - laneB;   // the lane neither row blocks
    this._coinLine(safe, z, 6);
    return offset + spacing;
  }

  /** A parked carriage: dodge it, or jump on the roof for a coin bonus. */
  _trainRow(z, spacing, rng) {
    const def = HAZARD_DEFS[HAZARD.TRAIN];
    const lanes = rng.shuffle([0, 1, 2]);
    // Two carriages may only occupy lanes that leave a *reachable* survivor.
    // Blocking both outer lanes is fine (centre stays open); blocking the
    // centre plus an outer lane strands the player on one side, so allow at
    // most one carriage whenever the centre is taken.
    const wantsTwo = rng.chance(0.35);
    const count = (wantsTwo && lanes[0] !== 1 && lanes[1] !== 1) ? 2 : 1;

    for (let i = 0; i < count; i++) {
      const lane = lanes[i];
      // Position is the centre of a long box.
      this.hazards.push(makeHazard(HAZARD.TRAIN, lane, z + def.depth / 2));
      // Roof coins: the risk/reward payoff for landing on top.
      if (i === 0) {
        for (let c = 0; c < 8; c++) {
          this.coins.push(makeCoin(
            LANE_X[lane], def.height + 0.75, z + 3 + c * COIN.spacing,
          ));
        }
      }
    }
    // A clear lane always exists (count is at most 2).
    this._coinLine(lanes[2], z + 4, 5);
    // Carriages are long: leave a full reaction gap after the tail, not just
    // the standard row spacing, so the next row is never read too late.
    return def.depth + spacing * 1.35;
  }

  /** Missing track: jump the void. */
  _gapRow(z, spacing, rng) {
    const def = HAZARD_DEFS[HAZARD.GAP];
    const lanes = rng.shuffle([0, 1, 2]);
    // Same reachability rule as carriages: never strand the player across a
    // blocked centre lane.
    const wantsTwo = rng.chance(0.4);
    const count = (wantsTwo && lanes[0] !== 1 && lanes[1] !== 1) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      this.hazards.push(makeHazard(HAZARD.GAP, lanes[i], z + def.depth / 2));
    }
    // Floating coins above the void reward jumping rather than dodging.
    this._coinArc(lanes[0], z, 5);
    return def.depth + spacing;
  }

  /** Hovering drone that slides between lanes; slide under or dodge. */
  _droneRow(z, spacing, rng) {
    const lane = rng.int(0, 2);
    this.hazards.push(makeHazard(HAZARD.DRONE, lane, z, {
      // Drifts laterally, bouncing between the outer lanes.
      vx: rng.chance(0.5) ? 1.6 : -1.6,
      driftMin: LANE_X[0],
      driftMax: LANE_X[2],
    }));
    this._coinLine((lane + 2) % 3, z, 5);
    return spacing;
  }

  /** Pick a hazard that blocks a single lane. */
  _pickBlocker(kinds, rng) {
    const options = kinds.filter(
      (k) => k !== HAZARD.GAP && k !== HAZARD.TRAIN && k !== HAZARD.DRONE,
    );
    return rng.pick(options.length ? options : [HAZARD.BARRIER]);
  }

  /** Pick a hazard clearable without leaving the lane (jump or slide). */
  _pickSimple(kinds, rng) {
    return rng.pick(this._simpleKinds(kinds));
  }

  /**
   * Restrict a kind list to hazards clearable *without* changing lane.
   * Used whenever the player's lateral freedom is already spoken for.
   */
  _simpleKinds(kinds) {
    const simple = kinds.filter((k) => k === HAZARD.BARRIER || k === HAZARD.GATE);
    return simple.length ? simple : [HAZARD.BARRIER];
  }

  /**
   * Place coins that teach the correct response to a hazard.
   *
   * Coins are the game's strongest teaching signal: putting them exactly where
   * a correct jump or slide carries the player means the reward path and the
   * survival path are the same line.
   */
  _rewardRow(kind, lane, z) {
    switch (kind) {
      case HAZARD.BARRIER:
        // Arc over the top, peaking at the jump apex.
        this._coinArc(lane, z - 3, 6);
        break;
      case HAZARD.GATE:
        // Low line that threads under the beam.
        this._coinLine(lane, z - 2, 5, 0.55);
        break;
      default: {
        // Solid hazard: reward the dodge by baiting an adjacent lane.
        const safe = (lane + 1) % 3;
        this._coinLine(safe, z, 5);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Coin helpers
  // -------------------------------------------------------------------------

  /** Straight run of coins down a lane. */
  _coinLine(lane, z, count, height = COIN.height) {
    for (let i = 0; i < count; i++) {
      this.coins.push(makeCoin(LANE_X[lane], height, z + i * COIN.spacing));
    }
  }

  /** Coins in a jump-shaped arc, guiding the player over an obstacle. */
  _coinArc(lane, z, count) {
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1 || 1);
      // Parabola peaking at ~2 m, matching the jump apex.
      const height = COIN.height + Math.sin(t * Math.PI) * 1.35;
      this.coins.push(makeCoin(LANE_X[lane], height, z + i * COIN.spacing));
    }
  }

  // -------------------------------------------------------------------------
  // Special spawns
  // -------------------------------------------------------------------------

  /**
   * Occasionally launch an oncoming express train down one lane.
   *
   * Lane choice is not random: the express takes the lane that leaves the
   * cleanest escape route, so the player is never squeezed between a train and
   * a wall of solid hazards.
   */
  _maybeLaunchExpress(playerZ, distance, speed) {
    if (distance < DIFFICULTY.unlocks.express) return;
    if (this.expressCooldown > 0) return;

    const def = HAZARD_DEFS[HAZARD.EXPRESS];
    const spawnZ = playerZ + 165;

    // Score each lane by how much solid clutter it already contains in the
    // stretch the player must survive. Blocking the busiest lane leaves the
    // clearest alternatives open.
    const clutter = [0, 0, 0];
    for (const hazard of this.hazards) {
      if (hazard.z < playerZ || hazard.z > spawnZ) continue;
      const lane = LANE_X.indexOf(hazard.x);
      if (lane < 0) continue;
      // Only dodge-only hazards constrain lane choice.
      if (hazard.kind === HAZARD.PYLON || hazard.kind === HAZARD.TRAIN ||
          hazard.kind === HAZARD.GAP) {
        clutter[lane] += 1;
      }
    }

    // Prefer the most cluttered lane; break ties randomly for variety.
    let lane = 0;
    let bestScore = -1;
    const order = this.rng.shuffle([0, 1, 2]);
    for (const candidate of order) {
      if (clutter[candidate] > bestScore) {
        bestScore = clutter[candidate];
        lane = candidate;
      }
    }

    this.hazards.push(makeHazard(HAZARD.EXPRESS, lane, spawnZ, {
      vz: -def.speed,
      warn: 2.2,
    }));
    this.expressLane = lane;
    // Longer gap at lower difficulty; never two in a row immediately.
    this.expressCooldown = remap(distance, 1600, 6000, 16, 7);
  }

  /** Drop a power-up crate every POWER_SPACING metres. */
  _maybePlacePower(playerZ, distance) {
    if (playerZ + 90 < this.lastPowerZ + POWER_SPACING) return;
    const lane = this.rng.int(0, 2);
    const kind = this.rng.weighted(POWER_WEIGHTS);
    this.lastPowerZ = playerZ + 90;
    this.powers.push(makePower(kind, LANE_X[lane], 1.25, this.lastPowerZ));
  }

  // -------------------------------------------------------------------------
  // Per-frame simulation
  // -------------------------------------------------------------------------

  /** Advance moving hazards and recycle anything behind the runner. */
  update(dt, playerZ) {
    this.expressCooldown = Math.max(0, this.expressCooldown - dt);

    let expressActive = false;
    const hazards = this.hazards;

    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];

      if (h.vz) h.z += h.vz * dt;

      if (h.vx) {
        h.x += h.vx * dt;
        // Bounce drifting drones between the outer lanes.
        if (h.x <= h.driftMin) { h.x = h.driftMin; h.vx = Math.abs(h.vx); }
        else if (h.x >= h.driftMax) { h.x = h.driftMax; h.vx = -Math.abs(h.vx); }
      }

      if (h.warn > 0) h.warn = Math.max(0, h.warn - dt);

      if (h.kind === HAZARD.EXPRESS && h.z - playerZ > -40) expressActive = true;

      // Cull well behind the camera (long trains need their full depth).
      if (h.z + h.halfDepth < playerZ + CULL_BEHIND) {
        const last = hazards.length - 1;
        if (i !== last) hazards[i] = hazards[last];
        hazards.pop();
      }
    }

    if (!expressActive) this.expressLane = -1;

    this._cullBehind(this.coins, playerZ);
    this._cullBehind(this.powers, playerZ);
  }

  _cullBehind(list, playerZ) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].z < playerZ + CULL_BEHIND || list[i].collected) {
        const last = list.length - 1;
        if (i !== last) list[i] = list[last];
        list.pop();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries used by collision
  // -------------------------------------------------------------------------

  /**
   * Height of the walkable surface at a position.
   *
   * Returns 0 for normal track, the roof height when standing over a rideable
   * carriage, and -Infinity over a gap (i.e. nothing to land on).
   */
  groundHeightAt(x, z) {
    let ground = 0;
    let overGap = false;

    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (Math.abs(z - h.z) > h.halfDepth) continue;
      if (Math.abs(x - h.x) > h.halfWidth) continue;

      if (h.kind === HAZARD.GAP) {
        overGap = true;
      } else if (h.rideable) {
        const roof = h.y + h.halfHeight;
        if (roof > ground) ground = roof;
      }
    }

    if (overGap && ground === 0) return -Infinity;
    return ground;
  }
}
