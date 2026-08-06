/**
 * Game core: the state machine that ties every system together.
 *
 * Responsibilities:
 *   * fixed-timestep simulation loop with interpolated rendering
 *   * collision resolution and death handling
 *   * scoring, combo chain, power-up timers
 *   * mission tracking and run statistics
 *
 * It owns no DOM and no React state. The UI subscribes via `onEvent` and reads
 * `hud` once per animation frame, so React re-renders can never stall the loop.
 */

import { audio } from './audio.js';
import { Camera } from './camera.js';
import {
  FIXED_STEP, FX, HAZARD, LANE_X, MAX_FRAME_TIME, POWER, POWER_DEFS,
  SCORE, SPEED,
} from './constants.js';
import { ACTION, input } from './input.js';
import { ParticleSystem } from './particles.js';
import { Player } from './player.js';
import { Renderer } from './renderer.js';
import { World } from './world.js';
import {
  boxesOverlap, clamp, clamp01, makeRng, prefersReducedMotion, remap, vibrate,
} from './util.js';

/** High-level game states. */
export const STATE = {
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DYING: 'dying',
  OVER: 'over',
};

/** Seconds the death animation plays before the results panel appears. */
const DEATH_DURATION = 1.5;

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(event:string, payload?:any)=>void} onEvent UI event sink
   */
  constructor(canvas, onEvent) {
    this.canvas = canvas;
    this.onEvent = onEvent || (() => {});

    this.camera = new Camera();
    this.renderer = new Renderer(canvas, this.camera);
    this.particles = new ParticleSystem();
    this.player = new Player();
    this.rng = makeRng(Date.now());
    this.world = new World(this.rng);

    this.state = STATE.MENU;
    this.reducedMotion = prefersReducedMotion();

    /** Upgrade-derived stats, refreshed from the profile before each run. */
    this.stats = {
      magnetSeconds: POWER_DEFS[POWER.MAGNET].duration,
      shieldSeconds: POWER_DEFS[POWER.SHIELD].duration,
      turboSeconds: POWER_DEFS[POWER.TURBO].duration,
      coinScore: SCORE.perCoin,
      headStartMetres: 0,
      comboGrace: SCORE.comboGrace,
      hoverboards: 0,
    };

    /** Populated by `_buildHud()` each frame and read by React. */
    this.hud = {};

    this._raf = 0;
    this._lastTime = 0;
    this._accumulator = 0;
    this._running = false;

    this._resetRunState();
    this._bindLifecycle();
  }

  // =========================================================================
  // Setup
  // =========================================================================

  _bindLifecycle() {
    // Auto-pause when the tab is hidden: prevents a huge dt on return and
    // stops the player dying while they are not looking.
    this._onVisibility = () => {
      if (document.hidden && this.state === STATE.PLAYING) this.pause();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onResize = () => this.renderer.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    input.onPause = () => {
      if (this.state === STATE.PLAYING) this.pause();
      else if (this.state === STATE.PAUSED) this.resume();
    };
  }

  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
  }

  /** Apply shop upgrades to the derived stat block. */
  applyUpgrades(upgrades = {}, catalog = []) {
    // Start from the defaults, then layer each purchased tier.
    this.stats.magnetSeconds = POWER_DEFS[POWER.MAGNET].duration;
    this.stats.shieldSeconds = POWER_DEFS[POWER.SHIELD].duration;
    this.stats.turboSeconds = POWER_DEFS[POWER.TURBO].duration;
    this.stats.coinScore = SCORE.perCoin;
    this.stats.headStartMetres = 0;
    this.stats.comboGrace = SCORE.comboGrace;
    this.stats.hoverboards = 0;

    for (const item of catalog) {
      const level = upgrades[item.id] || 0;
      if (!level || !item.effect) continue;
      const { stat, base, per_level: perLevel } = item.effect;
      if (!(stat in this.stats)) continue;
      // Consumables store a raw count; upgrades store base + tiers.
      this.stats[stat] = item.kind === 'consumable'
        ? level
        : base + perLevel * level;
    }
  }

  setSkin(skin) {
    this.player.skin = skin;
  }

  // =========================================================================
  // Run lifecycle
  // =========================================================================

  _resetRunState() {
    /** Elapsed wall-clock time in the current run (seconds). */
    this.runTime = 0;
    /** Free-running clock used for animation phases. */
    this.time = 0;

    this.score = 0;
    this.coins = 0;
    this.distance = 0;
    this.speed = SPEED.start;
    this.targetSpeed = SPEED.start;

    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.multiplier = 1;

    /** Active power-up timers, in seconds. */
    this.powers = { magnet: 0, shield: 0, turbo: 0, double: 0 };

    this.hoverboardsLeft = 0;
    this.deathTimer = 0;
    this.deathCause = '';

    this.hitFlash = 0;
    this.pickupFlash = 0;

    /** Floating world-space score popups. */
    this.popups = [];

    /** Per-run counters used by missions and the results screen. */
    this.runStats = {
      coins: 0, jumps: 0, slides: 0, nearMisses: 0,
      powerups: 0, laneChanges: 0, roofTime: 0, maxSpeed: 0,
    };

    this.countdown = 0;
    this.paused = false;
  }

  /**
   * Begin a new run.
   * @param {object} options `{ seed, skin }`
   */
  start({ seed = Date.now(), skin = 'cyan' } = {}) {
    this._resetRunState();

    this.rng = makeRng(seed >>> 0);
    this.world.rng = this.rng;
    this.world.reset();

    // The head-start upgrade begins the run further along, with the score and
    // difficulty already scaled to match.
    const headStart = this.stats.headStartMetres || 0;
    this.distance = headStart;
    this.score = Math.floor(headStart * SCORE.perMetre);

    this.player.reset(headStart, skin);
    this.hoverboardsLeft = Math.floor(this.stats.hoverboards || 0);
    this.particles.clear();
    this.camera.snapTo(this.player);

    // Pre-generate the track ahead so nothing pops in on the first frames.
    this.world.cursorZ = this.player.z + 45;
    this.world.lastPowerZ = this.player.z + 120;
    this.world.generate(this.player.z, this.distance, this.speed);

    input.clear();
    audio.resetMusic();

    this.countdown = 3.0;
    this.state = STATE.COUNTDOWN;
    this._emit('start');
    this.run();
  }

  pause() {
    if (this.state !== STATE.PLAYING && this.state !== STATE.COUNTDOWN) return;
    this._pausedFrom = this.state;
    this.state = STATE.PAUSED;
    input.clear();
    this._emit('pause');
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = this._pausedFrom || STATE.PLAYING;
    // Drop the accumulated time so the loop does not fast-forward.
    this._lastTime = performance.now();
    this._accumulator = 0;
    this._emit('resume');
  }

  /** Abandon the current run and return to the menu. */
  quit() {
    this.state = STATE.MENU;
    input.clear();
    this._emit('quit');
  }

  // =========================================================================
  // Main loop
  // =========================================================================

  run() {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    this._accumulator = 0;
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      this._frame(now);
    };
    this._raf = requestAnimationFrame(frame);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _frame(now) {
    // Clamp dt so a backgrounded tab or a GC hitch cannot teleport the player
    // through obstacles ("tunnelling").
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, MAX_FRAME_TIME);

    this.renderer.resize();
    input.pollGamepad();

    switch (this.state) {
      case STATE.COUNTDOWN:
        this._updateCountdown(dt);
        break;
      case STATE.PLAYING:
        this._stepFixed(dt);
        break;
      case STATE.DYING:
        this._updateDying(dt);
        break;
      case STATE.PAUSED:
      case STATE.MENU:
      case STATE.OVER:
      default:
        // Keep the clock running so idle animations continue behind menus.
        this.time += dt;
        break;
    }

    // Visual-only decays run on real dt, independent of the fixed step.
    this.camera.updateShake(dt, FX.shakeDecay);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.6);
    this.pickupFlash = Math.max(0, this.pickupFlash - dt * 3.4);
    this._updatePopups(dt);

    audio.updateMusic(
      dt, this.speedRatio,
      this.state === STATE.PLAYING || this.state === STATE.COUNTDOWN,
    );

    this._buildHud();
    this.renderer.render(this.renderState);
  }

  /**
   * Fixed-timestep integration.
   *
   * Physics runs at a constant 120 Hz regardless of display refresh rate, so
   * jump arcs and collisions are identical on a 60 Hz phone and a 240 Hz
   * monitor. Leftover time carries into the next frame.
   */
  _stepFixed(dt) {
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= FIXED_STEP && steps < 12) {
      this._update(FIXED_STEP);
      this._accumulator -= FIXED_STEP;
      steps++;
    }
    // If we hit the step cap the machine is too slow; drop the backlog rather
    // than accumulating an ever-growing debt.
    if (steps >= 12) this._accumulator = 0;
  }

  _updateCountdown(dt) {
    this.time += dt;
    const before = Math.ceil(this.countdown);
    this.countdown -= dt;
    const after = Math.ceil(this.countdown);

    if (after !== before && after >= 0) {
      audio.countdown(after === 0);
      this._emit('countdown', after);
    }

    // Keep the camera alive and the world scrolling gently during the count.
    this.camera.follow(this.player, dt, 0);

    if (this.countdown <= 0) {
      this.state = STATE.PLAYING;
      this._accumulator = 0;
      this._lastTime = performance.now();
      this._emit('go');
    }
  }

  _updateDying(dt) {
    this.time += dt;
    this.deathTimer -= dt;
    this.player.updateDeath(dt);
    this.particles.update(dt);
    // Slow, drifting camera pull-back for the death beat.
    this.camera.z += (this.player.z - 11 - this.camera.z) * Math.min(1, dt * 2);
    this.camera.y += (2.6 - this.camera.y) * Math.min(1, dt * 2);

    if (this.deathTimer <= 0) {
      this.state = STATE.OVER;
      this._emit('gameover', this.result);
    }
  }

  // =========================================================================
  // Simulation step
  // =========================================================================

  _update(dt) {
    this.time += dt;
    this.runTime += dt;

    this._updateSpeed(dt);
    this._consumeInput();

    const before = this.player.z;
    this.player.update(dt, this.speed, this.world, input.held);
    const travelled = this.player.z - before;
    this.distance += travelled;

    // Distance score, scaled by the active multiplier.
    this.score += travelled * SCORE.perMetre * this.multiplier;

    this.world.update(dt, this.player.z);
    this.world.generate(this.player.z, this.distance, this.speed);

    this._updatePowers(dt);
    this._updateCombo(dt);
    this._collide(dt);
    this._collectCoins(dt);
    this._collectPowers();
    this._spawnRunFx(dt);

    this.particles.update(dt);
    this.camera.follow(this.player, dt, this.powers.turbo > 0 ? 1 : 0);

    // Falling into a gap is fatal once the runner drops far enough that no
    // recovery is possible.
    if (this.player.fellInGap && !this.player.dead) {
      this._die('gap');
    }

    this.runStats.maxSpeed = Math.max(this.runStats.maxSpeed, this.speed);
    if (this.player.groundY > 0.5 && this.player.grounded) {
      this.runStats.roofTime += dt;
    }
  }

  /** Ramp speed with distance, then ease the actual value toward it. */
  _updateSpeed(dt) {
    const base = remap(this.distance, 0, SPEED.rampDistance, SPEED.start, SPEED.max);
    this.targetSpeed = base * (this.powers.turbo > 0 ? SPEED.turboMultiplier : 1);
    // Easing prevents a jarring jolt when turbo starts or ends.
    this.speed += (this.targetSpeed - this.speed) * Math.min(1, SPEED.smoothing * dt);
  }

  /**
   * Drain one buffered input into a player action.
   *
   * Exactly one action is applied per fixed step (120/s, far more than anyone
   * can press). Draining several per step would let a burst of queued swipes
   * move the runner two lanes within a single frame, which feels like a
   * teleport and makes buffered input dangerous rather than forgiving.
   */
  _consumeInput() {
    const action = input.consume();
    if (action === null) return;

    const performed = this.player.applyAction(action, this.player.canJump());

    if (performed === ACTION.JUMP) {
      audio.jump();
      this.runStats.jumps++;
    } else if (performed === ACTION.DUCK) {
      audio.slide();
      this.runStats.slides++;
    } else if (performed === ACTION.LEFT || performed === ACTION.RIGHT) {
      audio.swipe();
      this.runStats.laneChanges++;
    } else if (action === ACTION.JUMP) {
      // Jump requested mid-air: re-buffer briefly so it fires on landing
      // instead of being swallowed.
      if (!input.hasBuffered(ACTION.JUMP) && this.player.airTime < 0.3) {
        input.push(ACTION.JUMP);
      }
    }
  }

  _updatePowers(dt) {
    for (const key of Object.keys(this.powers)) {
      if (this.powers[key] <= 0) continue;
      const before = this.powers[key];
      this.powers[key] = Math.max(0, before - dt);
      if (this.powers[key] === 0) this._emit('powerEnd', key);
    }

    // Score multiplier = combo tier * the x2 power-up.
    const comboTier = 1 + Math.min(
      SCORE.comboMax - 1,
      Math.floor(this.combo / SCORE.comboStep),
    );
    this.multiplier = comboTier * (this.powers.double > 0 ? POWER_DEFS.double.multiplier : 1);
  }

  _updateCombo(dt) {
    if (this.combo <= 0) return;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) {
      // Chain broken: decay rather than reset, which feels less punishing.
      this.combo = 0;
      this.comboTimer = 0;
      this._emit('comboEnd');
    }
  }

  _updatePopups(dt) {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const popup = this.popups[i];
      popup.life -= dt;
      if (popup.life <= 0) {
        const last = this.popups.length - 1;
        if (i !== last) this.popups[i] = this.popups[last];
        this.popups.pop();
      }
    }
  }

  // =========================================================================
  // Collision
  // =========================================================================

  _collide(dt) {
    if (this.player.dead) return;

    const player = this.player;
    const px = player.x, py = player.centerY, pz = player.z;
    const phx = player.halfWidth, phy = player.halfHeight, phz = player.halfDepth;
    // Turbo grants invulnerability as well as speed. Rows are spaced for the
    // *base* speed, so a 62% boost would otherwise shrink reaction time below
    // what the generator guarantees - turning a reward into a death sentence.
    // Smashing through at full tilt is also simply the best version of it.
    const invulnerable = player.invuln > 0 || this.powers.shield > 0 || this.powers.turbo > 0;

    for (const hazard of this.world.hazards) {
      // Cheap Z reject first: most hazards are nowhere near the player.
      if (Math.abs(hazard.z - pz) > hazard.halfDepth + phz + 2) continue;

      // Gaps are handled by the ground query, not box overlap.
      if (hazard.kind === HAZARD.GAP) continue;

      const overlapping = boxesOverlap(
        px, py, pz, phx, phy, phz,
        hazard.x, hazard.y, hazard.z, hazard.halfWidth, hazard.halfHeight, hazard.halfDepth,
      );

      if (overlapping) {
        // Landing on a rideable roof is not a collision. The player must be
        // clearly above the roof line and descending; anything else is a
        // side-on impact.
        if (hazard.rideable) {
          const roof = hazard.y + hazard.halfHeight;
          if (player.y >= roof - 0.22) continue;
        }

        if (invulnerable) {
          // Shielded: smash through and keep the momentum.
          this._smashHazard(hazard);
          continue;
        }

        this._impact(hazard);
        return;
      }

      // Near-miss scoring: awarded once per hazard as it passes the player.
      if (!hazard.scored && hazard.z < pz && hazard.z > pz - 3) {
        hazard.scored = true;
        const lateral = Math.abs(hazard.x - px) - (hazard.halfWidth + phx);
        const vertical = Math.abs(hazard.y - py) - (hazard.halfHeight + phy);
        const clearance = Math.max(lateral, vertical);
        if (clearance >= 0 && clearance < SCORE.nearMissRange) {
          this._nearMiss(hazard);
        }
      }
    }
  }

  _nearMiss(hazard) {
    const points = Math.round(SCORE.nearMiss * this.multiplier);
    this.score += points;
    this.runStats.nearMisses++;
    this._popup(`+${points}`, hazard.x, 2.0, hazard.z, '#b9ff2e');
    audio.nearMiss();
    this.camera.addShake(2.2);
    this._emit('nearMiss', points);
  }

  /** Shielded pass-through: destroy the hazard with feedback. */
  _smashHazard(hazard) {
    if (hazard.smashed) return;
    hazard.smashed = true;
    this.particles.smash(hazard.x, hazard.y, hazard.z, hazard.color);
    this.camera.addShake(6);
    audio.shieldBreak();
    // Remove it so it cannot be hit twice.
    hazard.halfWidth = 0;
    hazard.halfHeight = 0;
    hazard.halfDepth = 0;
    const points = Math.round(30 * this.multiplier);
    this.score += points;
    this._popup('SMASH!', hazard.x, 1.8, hazard.z, '#22e8ff');
  }

  /** A fatal (or shield-absorbed) impact. */
  _impact(hazard) {
    // Shield absorbs the hit and is consumed.
    if (this.powers.shield > 0) {
      this.powers.shield = 0;
      this.player.invuln = 1.4;
      this.particles.shieldHit(this.player.x, this.player.centerY, this.player.z);
      this.camera.addShake(11);
      this.hitFlash = 1;
      audio.shieldBreak();
      vibrate(40);
      this._emit('shieldBreak');
      return;
    }

    // Hoverboard save.
    if (this.hoverboardsLeft > 0) {
      this.hoverboardsLeft--;
      this.player.revive();
      this.particles.powerBurst(this.player.x, this.player.centerY, this.player.z, '#22e8ff');
      this.camera.addShake(9);
      this.hitFlash = 0.8;
      audio.revive();
      vibrate([20, 40, 30]);
      this._emit('hoverboardUsed', this.hoverboardsLeft);
      return;
    }

    this._die(hazard.kind);
  }

  _die(cause) {
    if (this.player.dead) return;

    this.player.dead = true;
    this.deathCause = cause;
    this.deathTimer = DEATH_DURATION;
    this.state = STATE.DYING;

    this.player.vy = 6;
    this.particles.explosion(this.player.x, this.player.centerY, this.player.z);
    this.camera.addShake(22);
    this.hitFlash = 1;
    audio.crash();
    vibrate([60, 30, 90]);
    input.clear();
    this._emit('death', cause);
  }

  // =========================================================================
  // Pickups
  // =========================================================================

  _collectCoins(dt) {
    if (this.player.dead) return;

    const player = this.player;
    const magnetActive = this.powers.magnet > 0;
    const magnetDef = POWER_DEFS[POWER.MAGNET];
    const magnetRadius2 = magnetDef.radius * magnetDef.radius;
    const pickup2 = 0.95 * 0.95;

    for (const coin of this.world.coins) {
      if (coin.collected) continue;

      const dz = coin.z - player.z;
      // Ignore coins far ahead or already behind.
      if (dz > magnetDef.radius || dz < -2) continue;

      const dx = coin.x - player.x;
      const dy = coin.y - player.centerY;

      if (magnetActive) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < magnetRadius2) {
          coin.magnetised = true;
          // Home toward the player, accelerating as it closes.
          const d = Math.sqrt(d2) || 1;
          const pull = magnetDef.pullSpeed * dt * (1 + (1 - d / magnetDef.radius));
          coin.x -= (dx / d) * pull;
          coin.y -= (dy / d) * pull;
          coin.z -= (dz / d) * pull;
        }
      }

      // Capture test (recompute after any magnet movement).
      const cdx = coin.x - player.x;
      const cdy = coin.y - player.centerY;
      const cdz = coin.z - player.z;
      const near = cdx * cdx + cdy * cdy + cdz * cdz;
      if (near < pickup2 || (coin.magnetised && near < 1.6)) {
        this._takeCoin(coin);
      }
    }
  }

  _takeCoin(coin) {
    coin.collected = true;
    this.coins++;
    this.runStats.coins++;

    const beforeTier = Math.floor(this.combo / SCORE.comboStep);
    this.combo++;
    this.comboTimer = this.stats.comboGrace;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const afterTier = Math.floor(this.combo / SCORE.comboStep);

    const points = Math.round(this.stats.coinScore * this.multiplier);
    this.score += points;

    this.particles.coinBurst(coin.x, coin.y, coin.z);
    audio.coin(this.combo);

    if (afterTier > beforeTier) {
      // Crossing a combo tier is a notable moment: call it out.
      audio.comboUp(afterTier);
      this._popup(`x${this.multiplier} COMBO`, coin.x, coin.y + 0.7, coin.z, '#b9ff2e');
      this.camera.addShake(3);
      this._emit('comboUp', this.multiplier);
    }
  }

  _collectPowers() {
    if (this.player.dead) return;
    const player = this.player;

    for (const power of this.world.powers) {
      if (power.collected) continue;
      const dx = power.x - player.x;
      const dy = power.y - player.centerY;
      const dz = power.z - player.z;
      if (dx * dx + dy * dy + dz * dz > 1.6) continue;

      power.collected = true;
      this._activatePower(power.kind, power);
    }
  }

  _activatePower(kind, at) {
    const def = POWER_DEFS[kind];
    // Upgrade-extended durations where applicable.
    const duration =
      kind === POWER.MAGNET ? this.stats.magnetSeconds
      : kind === POWER.SHIELD ? this.stats.shieldSeconds
      : kind === POWER.TURBO ? this.stats.turboSeconds
      : def.duration;

    // Re-collecting refreshes rather than stacks, so the HUD stays honest.
    this.powers[kind] = Math.max(this.powers[kind], duration);

    this.runStats.powerups++;
    this.pickupFlash = 1;
    this.camera.addShake(5);
    this.particles.powerBurst(at.x, at.y, at.z, def.color);
    audio.powerup();
    vibrate(25);
    this._popup(def.label.toUpperCase(), at.x, at.y + 0.9, at.z, def.color);
    this._emit('power', { kind, duration });
  }

  // =========================================================================
  // Feedback
  // =========================================================================

  /** Continuous run FX: footfall dust, speed trails, turbo flames. */
  _spawnRunFx(dt) {
    if (this.reducedMotion || this.player.dead) return;
    const player = this.player;

    if (player.justLanded > 0) {
      const ground = Number.isFinite(player.groundY) ? player.groundY : 0;
      this.particles.landingDust(player.x, ground, player.z, 0.5 + player.justLanded);
      audio.land(player.justLanded);
      this.camera.addShake(2 + player.justLanded * 5);
    }

    if (player.grounded && player.footStrike() && Math.random() < 0.5) {
      const ground = Number.isFinite(player.groundY) ? player.groundY : 0;
      this.particles.footstep(player.x, ground, player.z, '#8fa3c8');
    }

    // Speed streaks scale with how fast we are actually going.
    const ratio = this.speedRatio;
    if (ratio > 0.3 && Math.random() < ratio * 0.7) {
      this.particles.speedTrail(
        player.x, player.y, player.z, player.palette.trail, this.speed,
      );
    }

    // Turbo exhaust.
    if (this.powers.turbo > 0) {
      for (let i = 0; i < 2; i++) {
        this.particles.spawn({
          kind: 'spark',
          x: player.x + (Math.random() - 0.5) * 0.5,
          y: player.y + 0.25 + Math.random() * 0.5,
          z: player.z - 0.5,
          vx: (Math.random() - 0.5) * 1.5,
          vy: (Math.random() - 0.5) * 1.5,
          vz: -18 - Math.random() * 10,
          life: 0.26, size: 0.1, color: POWER_DEFS.turbo.color,
          gravity: 0, drag: 0.4,
        });
      }
    }
  }

  _popup(text, x, y, z, color) {
    // Cap the list so a coin storm cannot flood the screen.
    if (this.popups.length > 14) this.popups.shift();
    this.popups.push({ text, x, y, z, color, life: FX.popupLife });
  }

  _emit(event, payload) {
    try {
      this.onEvent(event, payload);
    } catch (error) {
      // A UI listener must never be able to kill the game loop.
      console.error('[game] event handler failed:', event, error);
    }
  }

  // =========================================================================
  // Derived state
  // =========================================================================

  /** Normalised 0..1 speed, used for FX intensity and music tempo. */
  get speedRatio() {
    return clamp01((this.speed - SPEED.start) / (SPEED.max - SPEED.start));
  }

  /** Bundle handed to the renderer each frame. */
  get renderState() {
    return {
      player: this.player,
      world: this.world,
      particles: this.particles,
      popups: this.popups,
      powers: this.powers,
      time: this.time,
      distance: this.distance,
      speedRatio: this.speedRatio,
      hitFlash: this.hitFlash,
      pickupFlash: this.pickupFlash,
      reducedMotion: this.reducedMotion,
    };
  }

  /** Snapshot for the results screen and score submission. */
  get result() {
    return {
      score: Math.floor(this.score),
      coins: this.coins,
      distance: Math.floor(this.distance),
      durationMs: Math.round(this.runTime * 1000),
      bestCombo: this.bestCombo,
      cause: this.deathCause,
      stats: { ...this.runStats },
    };
  }

  /**
   * Rebuild the HUD snapshot.
   *
   * A plain object rebuilt each frame (rather than React state updated from
   * the loop) keeps React out of the 120 Hz path entirely.
   */
  _buildHud() {
    const comboTier = 1 + Math.min(
      SCORE.comboMax - 1, Math.floor(this.combo / SCORE.comboStep));

    this.hud = {
      state: this.state,
      score: Math.floor(this.score),
      coins: this.coins,
      distance: Math.floor(this.distance),
      speed: this.speed,
      speedRatio: this.speedRatio,
      combo: this.combo,
      comboTier,
      multiplier: this.multiplier,
      comboRatio: this.comboTimer > 0
        ? clamp01(this.comboTimer / (this.stats.comboGrace || 1)) : 0,
      powers: {
        magnet: this.powers.magnet,
        shield: this.powers.shield,
        turbo: this.powers.turbo,
        double: this.powers.double,
      },
      powerMax: {
        magnet: this.stats.magnetSeconds,
        shield: this.stats.shieldSeconds,
        turbo: this.stats.turboSeconds,
        double: POWER_DEFS.double.duration,
      },
      hoverboards: this.hoverboardsLeft,
      countdown: Math.ceil(this.countdown),
    };
  }
}
