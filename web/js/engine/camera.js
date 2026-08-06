/**
 * Camera and 3D->2D projection.
 *
 * The renderer is a "fake 3D" perspective projector rather than a full 3D
 * engine: world points (x, y, z) are divided by depth to get screen positions.
 * That is all a rail-based runner needs, and it draws on a plain 2D canvas at
 * high frame rates on any device.
 *
 * Conventions:
 *   x -> lateral (metres, 0 = centre lane)
 *   y -> up      (metres, 0 = track surface)
 *   z -> forward (metres, absolute world distance)
 *
 * The camera trails the runner at `CAMERA.back` metres and looks down the +Z
 * axis with no rotation, so projection reduces to a scale-by-1/depth. Roll and
 * shake are applied as a 2D canvas transform by the renderer instead of being
 * baked into the projection, which keeps this cheap and exact.
 */

import { CAMERA } from './constants.js';
import { clamp, damp } from './util.js';

/** Depth closer than this is behind/at the lens and cannot be projected. */
const NEAR_PLANE = 0.35;

export class Camera {
  constructor() {
    /** World-space camera position. */
    this.x = 0;
    this.y = CAMERA.height;
    this.z = -CAMERA.back;

    /** Viewport in CSS pixels (set by resize). */
    this.width = 0;
    this.height = 0;

    /** Focal length in pixels, derived from viewport height. */
    this.focal = 0;
    /** Screen position of the vanishing point. */
    this.cx = 0;
    this.cy = 0;

    /** Screen-shake offsets, decayed by the renderer each frame. */
    this.shakeX = 0;
    this.shakeY = 0;
    /** Camera roll in radians (used for a subtle lean into lane changes). */
    this.roll = 0;
    /** Field-of-view punch: >1 briefly widens the view (turbo, impacts). */
    this.fovPunch = 1;
  }

  /**
   * Recompute projection parameters for a new viewport size.
   * @param {number} width  CSS pixel width
   * @param {number} height CSS pixel height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cx = width * 0.5;
    // On very wide/short viewports, keep the focal length tied to the smaller
    // dimension so the tunnel never looks stretched.
    const reference = Math.min(height, width * 0.75);
    this.focal = reference * CAMERA.focal;
    this.cy = height * CAMERA.horizon;
  }

  /**
   * Follow the runner.
   *
   * The camera only partially tracks lateral movement (`CAMERA.followX`). Full
   * tracking makes lane changes feel weightless; partial tracking keeps the
   * tunnel walls moving, which sells the sense of sideways motion.
   */
  follow(player, dt, turbo01 = 0) {
    const targetX = player.x * CAMERA.followX;
    this.x = damp(this.x, targetX, CAMERA.followSpeed, dt);

    // Rise slightly with the player so a jump does not leave the frame, but
    // stay mostly grounded so the horizon holds steady.
    const targetY = CAMERA.height + Math.max(0, player.y) * 0.32;
    this.y = damp(this.y, targetY, 5.0, dt);

    // Pull back under turbo for a wider, faster-feeling view.
    const back = CAMERA.back + CAMERA.turboBack * turbo01;
    this.z = damp(this.z, player.z - back, 8.5, dt);

    // Lean into the direction of travel.
    const targetRoll = clamp((player.x - this.x / CAMERA.followX) * -0.012, -0.05, 0.05);
    this.roll = damp(this.roll, targetRoll, 6, dt);

    this.fovPunch = damp(this.fovPunch, 1 + turbo01 * 0.09, 4, dt);
  }

  /** Snap the camera directly behind a player (used when a run starts). */
  snapTo(player) {
    this.x = player.x * CAMERA.followX;
    this.y = CAMERA.height;
    this.z = player.z - CAMERA.back;
    this.roll = 0;
    this.shakeX = this.shakeY = 0;
    this.fovPunch = 1;
  }

  /**
   * Project a world point to screen space.
   *
   * Returns a reusable object `{ x, y, scale, depth, visible }`. `scale` is
   * pixels-per-metre at that depth, which callers use to size geometry.
   *
   * The returned object is a shared scratch instance - copy any values you need
   * to keep before the next call. This avoids allocating thousands of objects
   * per frame.
   */
  project(x, y, z, out = _scratch) {
    const depth = z - this.z;
    if (depth <= NEAR_PLANE) {
      out.visible = false;
      out.depth = depth;
      // Still fill in plausible values so callers cannot read stale garbage.
      out.x = this.cx;
      out.y = this.cy;
      out.scale = 0;
      return out;
    }

    const perspective = (this.focal * this.fovPunch) / depth;
    out.x = this.cx + (x - this.x) * perspective;
    out.y = this.cy - (y - this.y) * perspective;
    out.scale = perspective;
    out.depth = depth;
    out.visible = true;
    return out;
  }

  /**
   * Project into a fresh object.
   *
   * Use where a value must outlive the next `project()` call (e.g. building a
   * polygon path) and clarity beats micro-optimisation.
   */
  projectNew(x, y, z) {
    return this.project(x, y, z, { x: 0, y: 0, scale: 0, depth: 0, visible: false });
  }

  /** Add screen shake, taking the strongest pending value rather than summing. */
  addShake(amount) {
    const magnitude = Math.abs(amount);
    if (magnitude > Math.abs(this.shakeX)) {
      const angle = Math.random() * Math.PI * 2;
      this.shakeX = Math.cos(angle) * magnitude;
      this.shakeY = Math.sin(angle) * magnitude;
    }
  }

  /** Decay shake toward zero; called once per rendered frame. */
  updateShake(dt, decay) {
    const factor = Math.exp(-decay * dt);
    this.shakeX *= factor;
    this.shakeY *= factor;
    if (Math.abs(this.shakeX) < 0.05) this.shakeX = 0;
    if (Math.abs(this.shakeY) < 0.05) this.shakeY = 0;
  }
}

/** Shared scratch object for `project()`. */
const _scratch = { x: 0, y: 0, scale: 0, depth: 0, visible: false };
