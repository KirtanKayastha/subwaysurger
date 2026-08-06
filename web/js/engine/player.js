/**
 * The runner: state, physics and animation.
 *
 * Kept deliberately free of scoring, audio and particle concerns - those live
 * in `game.js`. This class answers one question well: "given input and the
 * track, where is the runner and what pose is it in?"
 *
 * Feel notes:
 *  * Lane changes are a timed tween, not a velocity, so they are always crisp
 *    and predictable rather than momentum-based.
 *  * Jumps use asymmetric gravity (heavier while falling) plus a variable
 *    height cutoff on early release - the standard platformer trick that makes
 *    a jump feel controlled instead of floaty.
 *  * Coyote time and input buffering (see `input.js`) hide the small timing
 *    errors every player makes, which reads as "responsive controls".
 */

import { ACTION } from './input.js';
import { LANE_X, PLAYER, SKINS } from './constants.js';
import { clamp, clamp01, damp, easeOutCubic, TAU } from './util.js';

/** Runner poses, used by the renderer to select a silhouette. */
export const POSE = {
  RUN: 'run',
  JUMP: 'jump',
  FALL: 'fall',
  SLIDE: 'slide',
  CRASH: 'crash',
};

export class Player {
  constructor() {
    this.reset();
  }

  reset(startZ = 0, skin = 'cyan') {
    /** Lane index 0/1/2 the runner is committed to. */
    this.lane = 1;
    /** Lane the tween started from. */
    this.fromLane = 1;
    /** Tween progress 0..1 (1 = settled). */
    this.laneT = 1;

    /** World position. `y` is the feet. */
    this.x = LANE_X[1];
    this.y = 0;
    this.z = startZ;

    /** Vertical velocity (m/s). */
    this.vy = 0;

    /** Height of the surface currently underfoot. */
    this.groundY = 0;
    this.grounded = true;
    /** Seconds since leaving the ground, for coyote time. */
    this.airTime = 0;
    /** True while a jump is rising and the button is still held. */
    this.jumpHeld = false;

    this.ducking = false;
    this.duckTimer = 0;

    /** Set when the runner dies; the loop then plays the death camera. */
    this.dead = false;
    /** Seconds of invulnerability remaining (post-revive). */
    this.invuln = 0;
    /** True while riding a hoverboard (cosmetic + one free hit). */
    this.hoverboard = false;

    /** Animation clocks. */
    this.runCycle = 0;
    this.leanX = 0;
    this.skin = SKINS[skin] ? skin : 'cyan';

    /** Set for one frame when the runner lands; read by the FX layer. */
    this.justLanded = 0;
    /** Set for one frame when a jump starts. */
    this.justJumped = false;
    /** Fall-through-gap flag so the game can distinguish death causes. */
    this.fellInGap = false;
  }

  /** Current collision half-extents, accounting for the slide pose. */
  get halfHeight() {
    return (this.ducking ? PLAYER.duckHeight : PLAYER.height) / 2;
  }

  get halfWidth() { return PLAYER.width / 2; }
  get halfDepth() { return PLAYER.depth / 2; }

  /** Centre of the collision box (physics uses feet, boxes use centres). */
  get centerY() { return this.y + this.halfHeight; }

  /** Visual pose for the renderer. */
  get pose() {
    if (this.dead) return POSE.CRASH;
    if (this.ducking) return POSE.SLIDE;
    if (!this.grounded) return this.vy > 0 ? POSE.JUMP : POSE.FALL;
    return POSE.RUN;
  }

  get palette() { return SKINS[this.skin] || SKINS.cyan; }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Apply one buffered intent.
   * @returns {string|null} the action actually performed, for SFX triggering
   */
  applyAction(action, canJump) {
    switch (action) {
      case ACTION.LEFT:
        return this._changeLane(-1);
      case ACTION.RIGHT:
        return this._changeLane(1);
      case ACTION.JUMP:
        if (canJump) { this._startJump(); return ACTION.JUMP; }
        return null;
      case ACTION.DUCK:
        return this._startDuck();
      default:
        return null;
    }
  }

  _changeLane(direction) {
    const target = this.lane + direction;
    if (target < 0 || target > 2) return null;
    // Re-target mid-tween from the current visual position so rapid double
    // taps do not snap or stutter.
    this.fromLane = this.lane;
    this.lane = target;
    this.laneT = 0;
    // NOTE: a lane change deliberately does NOT cancel a slide. Cancelling it
    // would stand the runner up while still under a gate - dodging the next
    // obstacle would silently kill you mid-slide, which reads as a bug.
    return direction < 0 ? ACTION.LEFT : ACTION.RIGHT;
  }

  _startJump() {
    this.vy = PLAYER.jumpVelocity;
    this.grounded = false;
    this.airTime = PLAYER.coyoteTime + 1;   // consumes coyote window
    this.jumpHeld = true;
    this.justJumped = true;
    if (this.ducking) this._endDuck();
  }

  _startDuck() {
    if (this.ducking) {
      // Re-pressing extends the slide rather than being ignored.
      this.duckTimer = PLAYER.duckDuration;
      return null;
    }
    this.ducking = true;
    this.duckTimer = PLAYER.duckDuration;
    // Slam down out of a jump: makes duck useful as an air-brake.
    if (!this.grounded && this.vy > -4) this.vy = -18;
    return ACTION.DUCK;
  }

  _endDuck() {
    this.ducking = false;
    this.duckTimer = 0;
  }

  /** True when a jump is currently legal (grounded or inside coyote time). */
  canJump() {
    return this.grounded || this.airTime <= PLAYER.coyoteTime;
  }

  // -------------------------------------------------------------------------
  // Physics
  // -------------------------------------------------------------------------

  /**
   * Advance one fixed step.
   *
   * @param {number} dt      fixed timestep
   * @param {number} speed   forward speed (m/s)
   * @param {object} world   world, queried for ground height
   * @param {object} held    currently-held input state
   */
  update(dt, speed, world, held) {
    this.justJumped = false;
    this.justLanded = 0;

    // --- forward motion -------------------------------------------------
    this.z += speed * dt;
    this.runCycle += dt * clamp(speed * 0.42, 4, 26);

    // --- lateral tween --------------------------------------------------
    if (this.laneT < 1) {
      this.laneT = clamp01(this.laneT + dt / PLAYER.laneChangeTime);
      const eased = easeOutCubic(this.laneT);
      this.x = LANE_X[this.fromLane] + (LANE_X[this.lane] - LANE_X[this.fromLane]) * eased;
    } else {
      this.x = LANE_X[this.lane];
    }
    // Visual lean, proportional to lateral velocity.
    const laneDelta = LANE_X[this.lane] - this.x;
    this.leanX = damp(this.leanX, clamp(laneDelta * 0.9, -1, 1), 12, dt);

    // --- slide timer ----------------------------------------------------
    if (this.ducking) {
      this.duckTimer -= dt;
      // Holding the key keeps the slide alive (up to a hard cap) so players can
      // hold under long gates.
      if (this.duckTimer <= 0) {
        if (held && held.duck && this.grounded) this.duckTimer = 0.12;
        else this._endDuck();
      }
    }

    // --- vertical -------------------------------------------------------
    // Jump height is fixed (see PLAYER.jumpVelocity commentary): taps and
    // holds produce an identical arc, so touch and keyboard play the same.
    const gravity = this.vy < 0
      ? PLAYER.gravity * PLAYER.fallMultiplier
      : PLAYER.gravity;
    this.vy += gravity * dt;
    this.y += this.vy * dt;

    // --- ground resolution ----------------------------------------------
    const ground = world.groundHeightAt(this.x, this.z);
    this.groundY = ground;

    if (ground === -Infinity) {
      // Over a gap: nothing to stand on.
      this.grounded = false;
      this.airTime += dt;
      // Once well below the track the fall is unrecoverable.
      if (this.y < -3.2) this.fellInGap = true;
    } else if (this.y <= ground) {
      const impact = -this.vy;
      this.y = ground;
      this.vy = 0;
      if (!this.grounded) {
        // Report impact strength so FX can scale the landing.
        this.justLanded = clamp01(impact / 16);
        this.jumpHeld = false;
      }
      this.grounded = true;
      this.airTime = 0;
    } else {
      this.grounded = false;
      this.airTime += dt;
    }

    // --- timers ---------------------------------------------------------
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
  }

  /**
   * Death animation state, driven by `game.js` after a crash.
   * Keeps the body tumbling so the game-over camera has something to watch.
   */
  updateDeath(dt) {
    this.vy += PLAYER.gravity * 0.6 * dt;
    this.y += this.vy * dt;
    this.z += 1.5 * dt;              // slight forward slump
    this.runCycle += dt * 6;
    if (this.y < -2) { this.y = -2; this.vy = 0; }
  }

  /** Grant invulnerability and pop the runner up after a hoverboard save. */
  revive() {
    this.dead = false;
    this.fellInGap = false;
    this.invuln = PLAYER.reviveInvuln;
    this.hoverboard = true;
    this.y = Math.max(this.y, 0.6);
    this.vy = 7.5;
    this.grounded = false;
    this._endDuck();
  }

  /** Blink phase for the invulnerability flicker (0..1). */
  get blink() {
    if (this.invuln <= 0) return 1;
    return (Math.sin(this.invuln * 26) + 1) * 0.5 * 0.7 + 0.3;
  }

  /** Vertical bob of the torso while running, for the renderer. */
  get bob() {
    if (!this.grounded || this.ducking) return 0;
    return Math.abs(Math.sin(this.runCycle)) * 0.075;
  }

  /** Leg swing phase in radians. */
  get stride() {
    return Math.sin(this.runCycle) * 0.85;
  }

  /** True on the frame a foot strikes the ground (for dust + audio). */
  footStrike() {
    if (!this.grounded || this.ducking) return false;
    // Two strikes per cycle: detect zero-crossings of the stride sine.
    const phase = this.runCycle % Math.PI;
    return phase < 0.16;
  }
}
