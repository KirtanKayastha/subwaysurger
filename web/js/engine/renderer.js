/**
 * Canvas renderer.
 *
 * A 2D canvas pretending to be 3D. Geometry is drawn back-to-front (painter's
 * algorithm) using the camera's perspective divide, which is plenty for a
 * rail-based runner and runs smoothly on low-end phones where WebGL setup cost
 * and shader compilation would hurt.
 *
 * Performance decisions worth knowing:
 *  * Everything is drawn in a single pass per layer with minimal state changes;
 *    `ctx.save/restore` is avoided in hot loops.
 *  * Sub-pixel geometry is skipped early (`scale` tests) rather than submitted
 *    to the rasteriser.
 *  * Depth sorting only touches entities inside the view frustum.
 *  * Gradients that never change are created once and cached, since creating a
 *    gradient per frame is a surprisingly large cost.
 */

import {
  CEIL_Y, COIN, FX, HAZARD, HAZARD_DEFS, LANE_X, LANE_WIDTH,
  POWER_DEFS, VIEW_DISTANCE, WALL_X,
} from './constants.js';
import { POSE } from './player.js';
import { clamp, clamp01, mixHex, remap, rgba, shade, TAU } from './util.js';

/** World-Z interval between floor grid rungs (metres). */
const GRID_STEP = 4;
/** World-Z interval between wall pillars. */
const PILLAR_STEP = 12;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./camera.js').Camera} camera
   */
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    /** CSS-pixel viewport size. */
    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    /** Cached gradients, rebuilt only on resize. */
    this._skyGradient = null;
    this._vignette = null;

    /** Rolling render stats, handy while profiling. */
    this.stats = { drawn: 0, culled: 0 };

    /** Scratch array reused for depth sorting (avoids per-frame allocation). */
    this._sortBuffer = [];
  }

  /**
   * Resize the backing store to match the element and device pixel ratio.
   *
   * DPR is capped at 2: beyond that the extra pixels are invisible on a phone
   * but cost real milliseconds of fill rate.
   */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    this.camera.resize(width, height);
    this._buildGradients();
  }

  _buildGradients() {
    const ctx = this.ctx;
    const horizon = this.camera.cy;

    const sky = ctx.createLinearGradient(0, 0, 0, this.height);
    sky.addColorStop(0, '#0a0f28');
    sky.addColorStop(clamp01(horizon / this.height - 0.06), '#141c47');
    sky.addColorStop(clamp01(horizon / this.height), '#1e2a5e');
    sky.addColorStop(clamp01(horizon / this.height + 0.02), '#0b1030');
    sky.addColorStop(1, '#05060f');
    this._skyGradient = sky;

    const vignette = ctx.createRadialGradient(
      this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.32,
      this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.78,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.62)');
    this._vignette = vignette;
  }

  /**
   * Distance fade. Returns 1 up close, 0 past the far plane.
   * Everything drawn multiplies its alpha by this so geometry dissolves into
   * fog instead of popping in at the horizon.
   */
  fogAlpha(depth) {
    if (depth <= FX.fogStart) return 1;
    if (depth >= FX.fogEnd) return 0;
    return 1 - (depth - FX.fogStart) / (FX.fogEnd - FX.fogStart);
  }

  // =========================================================================
  // Frame
  // =========================================================================

  /**
   * Draw one frame.
   *
   * @param {object} state game state bundle (see game.js `renderState`)
   */
  render(state) {
    const ctx = this.ctx;
    const cam = this.camera;
    this.stats.drawn = 0;
    this.stats.culled = 0;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Global camera transform: shake + roll about the screen centre.
    const shakeX = cam.shakeX;
    const shakeY = cam.shakeY;
    if (shakeX || shakeY || cam.roll) {
      ctx.translate(this.width / 2 + shakeX, this.height / 2 + shakeY);
      ctx.rotate(cam.roll);
      ctx.translate(-this.width / 2, -this.height / 2);
    }

    this._drawSky(state);
    this._drawTunnel(state);
    this._drawTrack(state);
    this._drawEntities(state);
    this._drawPlayer(state);
    state.particles.draw(ctx, cam, (d) => this.fogAlpha(d));
    this._drawWarnings(state);
    this._drawPopups(state);

    // Reset transform before screen-space overlays so they are shake-free.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawOverlays(state);
  }

  // =========================================================================
  // Background
  // =========================================================================

  _drawSky(state) {
    const ctx = this.ctx;
    ctx.fillStyle = this._skyGradient || '#05060f';
    // Oversized to cover the shake/roll transform.
    ctx.fillRect(-80, -80, this.width + 160, this.height + 160);

    // Distant skyline silhouette: parallax-scrolled by distance travelled.
    // Purely decorative, and cheap - a handful of rects.
    const horizon = this.camera.cy;
    const scroll = (state.distance * 0.55) % 220;
    ctx.fillStyle = 'rgba(24, 32, 74, 0.72)';
    for (let i = -1; i < 14; i++) {
      const bx = i * 220 - scroll - 90;
      const h = 26 + ((i * 37) % 5) * 13;
      const w = 62 + ((i * 53) % 4) * 22;
      ctx.fillRect(bx, horizon - h, w, h);
    }
    // Window lights on the near towers.
    ctx.fillStyle = 'rgba(120, 190, 255, 0.16)';
    for (let i = -1; i < 14; i++) {
      const bx = i * 220 - scroll - 90;
      const h = 26 + ((i * 37) % 5) * 13;
      for (let wy = 6; wy < h - 4; wy += 9) {
        for (let wx = 7; wx < 50; wx += 12) {
          if (((i + wy + wx) % 7) < 3) ctx.fillRect(bx + wx, horizon - h + wy, 4, 4);
        }
      }
    }

    // Horizon glow: sells the "light at the end of the tunnel".
    const glow = ctx.createRadialGradient(
      this.camera.cx, horizon, 0, this.camera.cx, horizon, this.height * 0.42);
    glow.addColorStop(0, 'rgba(90, 190, 255, 0.28)');
    glow.addColorStop(0.5, 'rgba(60, 120, 220, 0.08)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  // =========================================================================
  // Tunnel shell
  // =========================================================================

  _drawTunnel(state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const playerZ = state.player.z;
    const nearZ = playerZ - 12;
    const farZ = playerZ + VIEW_DISTANCE;

    // --- floor slab ---
    const fl = cam.projectNew(-WALL_X, 0, farZ);
    const fr = cam.projectNew(WALL_X, 0, farZ);
    const nl = cam.projectNew(-WALL_X, 0, nearZ);
    const nr = cam.projectNew(WALL_X, 0, nearZ);

    if (nl.visible && fl.visible) {
      const floor = ctx.createLinearGradient(0, fl.y, 0, nl.y);
      floor.addColorStop(0, '#070a18');
      floor.addColorStop(0.35, '#101733');
      floor.addColorStop(1, '#18203f');
      ctx.fillStyle = floor;
      ctx.beginPath();
      ctx.moveTo(fl.x, fl.y);
      ctx.lineTo(fr.x, fr.y);
      ctx.lineTo(nr.x, nr.y);
      ctx.lineTo(nl.x, nl.y);
      ctx.closePath();
      ctx.fill();
    }

    // --- ceiling ---
    const cfl = cam.projectNew(-WALL_X, CEIL_Y, farZ);
    const cfr = cam.projectNew(WALL_X, CEIL_Y, farZ);
    const cnl = cam.projectNew(-WALL_X, CEIL_Y, nearZ);
    const cnr = cam.projectNew(WALL_X, CEIL_Y, nearZ);
    if (cnl.visible && cfl.visible) {
      const ceil = ctx.createLinearGradient(0, cfl.y, 0, cnl.y);
      ceil.addColorStop(0, '#0a0f26');
      ceil.addColorStop(1, '#05070f');
      ctx.fillStyle = ceil;
      ctx.beginPath();
      ctx.moveTo(cfl.x, cfl.y);
      ctx.lineTo(cfr.x, cfr.y);
      ctx.lineTo(cnr.x, cnr.y);
      ctx.lineTo(cnl.x, cnl.y);
      ctx.closePath();
      ctx.fill();
    }

    // --- side walls ---
    for (const side of [-1, 1]) {
      const wx = WALL_X * side;
      const wf = cam.projectNew(wx, 0, farZ);
      const wft = cam.projectNew(wx, CEIL_Y, farZ);
      const wn = cam.projectNew(wx, 0, nearZ);
      const wnt = cam.projectNew(wx, CEIL_Y, nearZ);
      if (!wn.visible || !wf.visible) continue;

      const wall = ctx.createLinearGradient(wf.x, 0, wn.x, 0);
      wall.addColorStop(0, '#080c1c');
      wall.addColorStop(1, '#151d3c');
      ctx.fillStyle = wall;
      ctx.beginPath();
      ctx.moveTo(wf.x, wf.y);
      ctx.lineTo(wft.x, wft.y);
      ctx.lineTo(wnt.x, wnt.y);
      ctx.lineTo(wn.x, wn.y);
      ctx.closePath();
      ctx.fill();
    }

    // --- floor grid rungs (perspective lines) ---
    // Drawn far->near so nearer, brighter lines overlay distant ones.
    const firstRung = Math.ceil(nearZ / GRID_STEP) * GRID_STEP;
    ctx.lineWidth = 1;
    for (let z = firstRung + Math.floor(VIEW_DISTANCE / GRID_STEP) * GRID_STEP;
         z >= firstRung; z -= GRID_STEP) {
      const a = cam.project(-WALL_X, 0, z);
      if (!a.visible) continue;
      const alpha = this.fogAlpha(a.depth) * 0.3;
      if (alpha <= 0.01) continue;
      const ax = a.x, ay = a.y;
      const b = cam.project(WALL_X, 0, z);
      ctx.strokeStyle = `rgba(90, 170, 255, ${alpha})`;
      ctx.lineWidth = Math.max(0.6, a.scale * 0.014);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // --- wall pillars + strip lights ---
    const firstPillar = Math.ceil(nearZ / PILLAR_STEP) * PILLAR_STEP;
    for (let z = firstPillar + Math.floor(VIEW_DISTANCE / PILLAR_STEP) * PILLAR_STEP;
         z >= firstPillar; z -= PILLAR_STEP) {
      const fog = this.fogAlpha(z - cam.z);
      if (fog <= 0.02) continue;

      for (const side of [-1, 1]) {
        const wx = WALL_X * side;
        const base = cam.project(wx, 0, z);
        if (!base.visible) continue;
        const bx = base.x, by = base.y, bScale = base.scale;
        const top = cam.project(wx, CEIL_Y, z);

        // Pillar
        ctx.strokeStyle = `rgba(70, 130, 220, ${fog * 0.4})`;
        ctx.lineWidth = Math.max(1, bScale * 0.09);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(top.x, top.y);
        ctx.stroke();

        // Glowing lamp partway up the pillar; alternate hue for rhythm.
        const lamp = cam.project(wx, 4.4, z);
        const hot = (Math.floor(z / PILLAR_STEP) % 3) === 0;
        const radius = Math.max(1.2, lamp.scale * 0.11);
        const lampGlow = ctx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, radius * 5);
        const color = hot ? '255,62,165' : '34,232,255';
        lampGlow.addColorStop(0, `rgba(${color}, ${fog * 0.95})`);
        lampGlow.addColorStop(0.35, `rgba(${color}, ${fog * 0.35})`);
        lampGlow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = lampGlow;
        ctx.beginPath();
        ctx.arc(lamp.x, lamp.y, radius * 5, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${fog})`;
        ctx.beginPath();
        ctx.arc(lamp.x, lamp.y, radius, 0, TAU);
        ctx.fill();
      }
    }

    // --- ceiling light strip down the centre ---
    const stripStep = 8;
    const firstStrip = Math.ceil(nearZ / stripStep) * stripStep;
    for (let z = firstStrip + Math.floor(VIEW_DISTANCE / stripStep) * stripStep;
         z >= firstStrip; z -= stripStep) {
      const p = cam.project(0, CEIL_Y - 0.15, z);
      if (!p.visible) continue;
      const fog = this.fogAlpha(p.depth);
      if (fog <= 0.02) continue;
      const w = Math.max(1, p.scale * 0.9);
      const h = Math.max(1, p.scale * 0.1);
      ctx.fillStyle = `rgba(150, 210, 255, ${fog * 0.5})`;
      ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
    }
  }

  // =========================================================================
  // Rails
  // =========================================================================

  _drawTrack(state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const playerZ = state.player.z;
    const nearZ = playerZ - 12;

    // Sleepers (cross ties), far -> near.
    const tieStep = 2.4;
    const firstTie = Math.ceil(nearZ / tieStep) * tieStep;
    for (let z = firstTie + Math.floor(VIEW_DISTANCE / tieStep) * tieStep;
         z >= firstTie; z -= tieStep) {
      const p = cam.project(0, 0.02, z);
      if (!p.visible) continue;
      const fog = this.fogAlpha(p.depth);
      if (fog <= 0.02) continue;
      const halfW = LANE_WIDTH * 1.55 * p.scale;
      const h = Math.max(0.7, p.scale * 0.11);
      ctx.fillStyle = `rgba(58, 72, 112, ${fog * 0.72})`;
      ctx.fillRect(p.x - halfW, p.y - h / 2, halfW * 2, h);
      this.stats.drawn++;
    }

    // Two glowing rails per lane.
    for (let lane = 0; lane < 3; lane++) {
      const cx = LANE_X[lane];
      for (const offset of [-0.62, 0.62]) {
        const x = cx + offset;
        const far = cam.projectNew(x, 0.05, playerZ + VIEW_DISTANCE * 0.72);
        const near = cam.projectNew(x, 0.05, nearZ);
        if (!far.visible || !near.visible) continue;

        // Rails brighten in the lane the player occupies - a subtle "you are
        // here" cue that reads instantly at speed.
        const isActive = lane === state.player.lane;
        const grad = ctx.createLinearGradient(0, far.y, 0, near.y);
        grad.addColorStop(0, 'rgba(60, 120, 200, 0)');
        grad.addColorStop(1, isActive
          ? 'rgba(120, 230, 255, 0.85)'
          : 'rgba(80, 140, 210, 0.5)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = Math.max(1, near.scale * 0.045);
        ctx.beginPath();
        ctx.moveTo(far.x, far.y);
        ctx.lineTo(near.x, near.y);
        ctx.stroke();
      }
    }
  }

  // =========================================================================
  // Entities
  // =========================================================================

  /**
   * Draw hazards, coins and power-ups in one depth-sorted pass.
   *
   * Sorting all three together (rather than per-type) is what makes coins
   * correctly disappear behind trains.
   */
  _drawEntities(state) {
    const cam = this.camera;
    const items = this._sortBuffer;
    items.length = 0;

    const pushIfVisible = (obj, type) => {
      const depth = obj.z - cam.z;
      if (depth <= 0.5 || depth > FX.fogEnd) { this.stats.culled++; return; }
      items.push({ obj, type, depth });
    };

    for (let i = 0; i < state.world.hazards.length; i++) {
      pushIfVisible(state.world.hazards[i], 'hazard');
    }
    for (let i = 0; i < state.world.coins.length; i++) {
      const c = state.world.coins[i];
      if (!c.collected) pushIfVisible(c, 'coin');
    }
    for (let i = 0; i < state.world.powers.length; i++) {
      const p = state.world.powers[i];
      if (!p.collected) pushIfVisible(p, 'power');
    }

    // Far to near.
    items.sort((a, b) => b.depth - a.depth);

    for (let i = 0; i < items.length; i++) {
      const { obj, type } = items[i];
      if (type === 'hazard') this._drawHazard(obj, state);
      else if (type === 'coin') this._drawCoin(obj, state);
      else this._drawPower(obj, state);
      this.stats.drawn++;
    }
  }

  /**
   * Draw an axis-aligned box in perspective.
   *
   * Painter order inside the box: far face, side faces, top, near face. Because
   * the camera always looks down +Z with no yaw, this ordering is always
   * correct - no per-face depth test needed.
   */
  _box(x, y, z, hx, hy, hz, colors, alpha) {
    const ctx = this.ctx;
    const cam = this.camera;

    const zN = z - hz, zF = z + hz;
    const xL = x - hx, xR = x + hx;
    const yB = y - hy, yT = y + hy;

    // Eight projected corners.
    const nbl = cam.projectNew(xL, yB, zN);
    const nbr = cam.projectNew(xR, yB, zN);
    const ntl = cam.projectNew(xL, yT, zN);
    const ntr = cam.projectNew(xR, yT, zN);
    const fbl = cam.projectNew(xL, yB, zF);
    const fbr = cam.projectNew(xR, yB, zF);
    const ftl = cam.projectNew(xL, yT, zF);
    const ftr = cam.projectNew(xR, yT, zF);

    if (!nbl.visible && !fbl.visible) return;

    const quad = (a, b, c, d, fill) => {
      if (!a.visible || !b.visible || !c.visible || !d.visible) return;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    };

    ctx.globalAlpha = alpha;

    // Far face (usually hidden, but matters for transparent/edge cases).
    quad(fbl, fbr, ftr, ftl, colors.far);
    // Side faces: only the one facing the camera is visible, but drawing both
    // is cheaper than the branch and the near face covers the other.
    quad(fbl, nbl, ntl, ftl, colors.side);
    quad(fbr, nbr, ntr, ftr, colors.side);
    // Top face.
    quad(ftl, ftr, ntr, ntl, colors.top);
    // Near face last.
    quad(nbl, nbr, ntr, ntl, colors.front);

    // Neon edge highlight around the near face - the signature look.
    if (colors.edge && nbl.visible && ntr.visible) {
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = Math.max(1, nbl.scale * 0.02);
      ctx.beginPath();
      ctx.moveTo(nbl.x, nbl.y);
      ctx.lineTo(nbr.x, nbr.y);
      ctx.lineTo(ntr.x, ntr.y);
      ctx.lineTo(ntl.x, ntl.y);
      ctx.closePath();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  _drawHazard(h, state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const depth = h.z - cam.z;
    const fog = this.fogAlpha(depth);
    if (fog <= 0.02) return;

    switch (h.kind) {
      case HAZARD.GAP:
        this._drawGap(h, fog);
        return;

      case HAZARD.GATE: {
        // Overhead beam plus support posts.
        const base = h.color;
        this._box(h.x, h.y, h.z, h.halfWidth, h.halfHeight, h.halfDepth, {
          front: shade(base, -0.15), top: shade(base, 0.25),
          side: shade(base, -0.4), far: shade(base, -0.55),
          edge: rgba('#fff6c2', fog * 0.9),
        }, fog);
        // Warning stripes on the underside make the "duck" read obvious.
        const p = cam.project(h.x, h.y - h.halfHeight, h.z - h.halfDepth);
        if (p.visible) {
          const w = h.halfWidth * 2 * p.scale;
          const hh = Math.max(1, p.scale * 0.09);
          ctx.globalAlpha = fog;
          for (let i = 0; i < 5; i++) {
            ctx.fillStyle = i % 2 ? '#1a1a1a' : '#ffd23e';
            ctx.fillRect(p.x - w / 2 + (w / 5) * i, p.y - hh / 2, w / 5, hh);
          }
          ctx.globalAlpha = 1;
        }
        return;
      }

      case HAZARD.DRONE: {
        this._drawDrone(h, fog, state);
        return;
      }

      case HAZARD.TRAIN:
      case HAZARD.EXPRESS: {
        this._drawCarriage(h, fog, state);
        return;
      }

      default: {
        // Barrier / pylon: a plain neon crate.
        const base = h.color;
        this._box(h.x, h.y, h.z, h.halfWidth, h.halfHeight, h.halfDepth, {
          front: shade(base, -0.1), top: shade(base, 0.3),
          side: shade(base, -0.38), far: shade(base, -0.5),
          edge: rgba('#ffffff', fog * 0.75),
        }, fog);

        // Chevron detail on the front face, pointing up = "jump me".
        const p = cam.project(h.x, h.y, h.z - h.halfDepth);
        if (p.visible && p.scale > 12) {
          const w = h.halfWidth * 1.1 * p.scale;
          ctx.strokeStyle = rgba('#ffffff', fog * 0.55);
          ctx.lineWidth = Math.max(1, p.scale * 0.022);
          ctx.beginPath();
          ctx.moveTo(p.x - w * 0.5, p.y + w * 0.22);
          ctx.lineTo(p.x, p.y - w * 0.16);
          ctx.lineTo(p.x + w * 0.5, p.y + w * 0.22);
          ctx.stroke();
        }
        return;
      }
    }
  }

  /** A hole in the track: dark void plus glowing torn edges. */
  _drawGap(h, fog) {
    const ctx = this.ctx;
    const cam = this.camera;
    const zN = h.z - h.halfDepth;
    const zF = h.z + h.halfDepth;
    const xL = h.x - h.halfWidth;
    const xR = h.x + h.halfWidth;

    const nl = cam.projectNew(xL, 0.03, zN);
    const nr = cam.projectNew(xR, 0.03, zN);
    const fl = cam.projectNew(xL, 0.03, zF);
    const fr = cam.projectNew(xR, 0.03, zF);
    if (!nl.visible || !fl.visible) return;

    ctx.globalAlpha = fog;
    // The void itself.
    const void_ = ctx.createLinearGradient(0, fl.y, 0, nl.y);
    void_.addColorStop(0, '#01020a');
    void_.addColorStop(1, '#000000');
    ctx.fillStyle = void_;
    ctx.beginPath();
    ctx.moveTo(fl.x, fl.y);
    ctx.lineTo(fr.x, fr.y);
    ctx.lineTo(nr.x, nr.y);
    ctx.lineTo(nl.x, nl.y);
    ctx.closePath();
    ctx.fill();

    // Hot edges on the near and far lips.
    ctx.strokeStyle = rgba('#ff4d5e', fog * 0.85);
    ctx.lineWidth = Math.max(1.2, nl.scale * 0.035);
    ctx.beginPath();
    ctx.moveTo(nl.x, nl.y); ctx.lineTo(nr.x, nr.y);
    ctx.moveTo(fl.x, fl.y); ctx.lineTo(fr.x, fr.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Train / express carriage with windows and headlights. */
  _drawCarriage(h, fog, state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const isExpress = h.kind === HAZARD.EXPRESS;
    const base = isExpress ? '#ff4d5e' : '#2f7de8';

    this._box(h.x, h.y, h.z, h.halfWidth, h.halfHeight, h.halfDepth, {
      front: shade(base, -0.05), top: shade(base, 0.22),
      side: shade(base, -0.42), far: shade(base, -0.55),
      edge: rgba(isExpress ? '#ffd0d4' : '#bfe4ff', fog * 0.9),
    }, fog);

    // Row of lit windows down the visible side.
    const sideX = h.x + (cam.x > h.x ? h.halfWidth : -h.halfWidth);
    const windows = Math.max(2, Math.floor(h.halfDepth * 2 / 3.4));
    ctx.globalAlpha = fog * 0.9;
    for (let i = 0; i < windows; i++) {
      const wz = h.z - h.halfDepth + 2.2 + i * 3.4;
      const p = cam.project(sideX, h.y + h.halfHeight * 0.28, wz);
      if (!p.visible) continue;
      const w = Math.max(1, p.scale * 0.5);
      const hh = Math.max(1, p.scale * 0.42);
      ctx.fillStyle = isExpress ? 'rgba(255, 226, 150, 0.85)' : 'rgba(190, 240, 255, 0.8)';
      ctx.fillRect(p.x - w / 2, p.y - hh / 2, w, hh);
    }
    ctx.globalAlpha = 1;

    // Express headlights sweep the tunnel toward the player.
    if (isExpress) {
      const nose = cam.project(h.x, h.y, h.z - h.halfDepth);
      if (nose.visible) {
        const r = Math.max(4, nose.scale * 0.9);
        const glow = ctx.createRadialGradient(nose.x, nose.y, 0, nose.x, nose.y, r);
        const pulse = 0.65 + Math.sin(state.time * 12 + h.phase) * 0.2;
        glow.addColorStop(0, `rgba(255,255,255,${fog * pulse})`);
        glow.addColorStop(0.4, `rgba(255,180,120,${fog * 0.4})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(nose.x, nose.y, r, 0, TAU);
        ctx.fill();
      }
    }
  }

  /** Hovering drone with rotors and a scanning eye. */
  _drawDrone(h, fog, state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const bob = Math.sin(state.time * 4 + h.phase) * 0.12;
    const p = cam.project(h.x, h.y + bob, h.z);
    if (!p.visible) return;

    const r = h.halfWidth * p.scale;
    ctx.globalAlpha = fog;

    // Body
    ctx.fillStyle = '#2a1030';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.62, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(h.color, 0.95);
    ctx.lineWidth = Math.max(1, p.scale * 0.03);
    ctx.stroke();

    // Rotor blur on each side.
    const spin = state.time * 30 + h.phase;
    ctx.strokeStyle = rgba('#ff9db0', 0.5);
    for (const side of [-1, 1]) {
      const rx = p.x + side * r * 1.05;
      ctx.beginPath();
      ctx.ellipse(rx, p.y - r * 0.42, r * 0.5,
                  Math.abs(Math.cos(spin)) * r * 0.14 + 1, 0, 0, TAU);
      ctx.stroke();
    }

    // Scanning eye.
    const eyeR = Math.max(1.4, r * 0.24);
    const pulse = 0.6 + Math.sin(state.time * 9 + h.phase) * 0.4;
    const eye = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, eyeR * 3);
    eye.addColorStop(0, `rgba(255,70,90,${pulse})`);
    eye.addColorStop(1, 'rgba(255,70,90,0)');
    ctx.fillStyle = eye;
    ctx.beginPath();
    ctx.arc(p.x, p.y, eyeR * 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, eyeR, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  /** Spinning coin with a glow halo. */
  _drawCoin(coin, state) {
    const ctx = this.ctx;
    const p = this.camera.project(coin.x, coin.y, coin.z);
    if (!p.visible) return;
    const fog = this.fogAlpha(p.depth);
    if (fog <= 0.02) return;

    const spin = state.time * 4.5 + coin.phase;
    const r = COIN.radius * p.scale;
    if (r < 0.6) return;

    // The coin "rotates" by squashing its width - cheap and very readable.
    const squash = Math.abs(Math.cos(spin)) * 0.85 + 0.15;

    ctx.globalAlpha = fog;
    // Halo
    const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    halo.addColorStop(0, 'rgba(255, 210, 62, 0.5)');
    halo.addColorStop(1, 'rgba(255, 210, 62, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, TAU);
    ctx.fill();

    // Body
    ctx.fillStyle = '#ffd23e';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r * squash, r, 0, 0, TAU);
    ctx.fill();

    // Inner shading + specular
    if (r > 3) {
      ctx.fillStyle = 'rgba(180, 120, 20, 0.55)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * squash * 0.58, r * 0.62, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 230, 0.9)';
      ctx.beginPath();
      ctx.ellipse(p.x - r * squash * 0.3, p.y - r * 0.34,
                  r * squash * 0.22, r * 0.2, 0, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Power-up crate: rotating cube with an icon glyph. */
  _drawPower(power, state) {
    const ctx = this.ctx;
    const def = POWER_DEFS[power.kind];
    const bob = Math.sin(state.time * 2.6 + power.phase) * 0.16;
    const p = this.camera.project(power.x, power.y + bob, power.z);
    if (!p.visible) return;
    const fog = this.fogAlpha(p.depth);
    if (fog <= 0.02) return;

    const r = 0.46 * p.scale;
    if (r < 1) return;
    const spin = state.time * 1.9 + power.phase;

    ctx.globalAlpha = fog;

    // Aura
    const aura = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    aura.addColorStop(0, rgba(def.color, 0.55));
    aura.addColorStop(0.5, rgba(def.color, 0.16));
    aura.addColorStop(1, rgba(def.color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3.2, 0, TAU);
    ctx.fill();

    // Rotating diamond body.
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(spin);
    ctx.fillStyle = rgba(def.color, 0.9);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.restore();

    // Icon glyph (drawn unrotated so it stays legible).
    if (r > 6) {
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(r * 1.05)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = power.kind === 'magnet' ? 'M'
        : power.kind === 'shield' ? 'S'
        : power.kind === 'turbo' ? '>' : 'x2';
      ctx.fillText(glyph, p.x, p.y + r * 0.04);
    }

    ctx.globalAlpha = 1;
  }

  // =========================================================================
  // Player
  // =========================================================================

  _drawPlayer(state) {
    const ctx = this.ctx;
    const cam = this.camera;
    const player = state.player;
    const palette = player.palette;

    const p = cam.project(player.x, player.y, player.z);
    if (!p.visible) return;

    const scale = p.scale;
    const unit = scale;                       // pixels per metre at the runner
    const pose = player.pose;
    const alpha = player.invuln > 0 ? player.blink : 1;

    // --- contact shadow ---
    // Anchored to the ground beneath the runner, shrinking as they rise, which
    // is the main visual cue for jump height.
    const groundY = Number.isFinite(player.groundY) ? player.groundY : 0;
    const shadow = cam.project(player.x, groundY + 0.01, player.z);
    if (shadow.visible) {
      const lift = clamp01((player.y - groundY) / 2.6);
      const sr = unit * 0.5 * (1 - lift * 0.45);
      ctx.globalAlpha = (1 - lift * 0.7) * 0.55;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(shadow.x, shadow.y, sr, sr * 0.3, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // --- shield bubble ---
    if (state.powers.shield > 0) {
      const r = unit * 1.35;
      const pulse = 0.7 + Math.sin(state.time * 7) * 0.14;
      const bubble = ctx.createRadialGradient(
        p.x, p.y - unit * 0.85, r * 0.3, p.x, p.y - unit * 0.85, r);
      bubble.addColorStop(0, 'rgba(34, 232, 255, 0.04)');
      bubble.addColorStop(0.72, `rgba(34, 232, 255, ${0.16 * pulse})`);
      bubble.addColorStop(1, `rgba(34, 232, 255, ${0.5 * pulse})`);
      ctx.fillStyle = bubble;
      ctx.beginPath();
      ctx.arc(p.x, p.y - unit * 0.85, r, 0, TAU);
      ctx.fill();
    }

    // --- magnet field rings ---
    if (state.powers.magnet > 0) {
      ctx.strokeStyle = rgba(POWER_DEFS.magnet.color, 0.32);
      ctx.lineWidth = Math.max(1, unit * 0.035);
      for (let i = 0; i < 2; i++) {
        const phase = (state.time * 1.4 + i * 0.5) % 1;
        ctx.globalAlpha = (1 - phase) * 0.5;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - unit * 0.3,
                    unit * (0.9 + phase * 2.4), unit * (0.3 + phase * 0.8),
                    0, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = alpha;

    // --- hoverboard ---
    if (player.hoverboard) {
      const boardY = p.y + unit * 0.06;
      ctx.fillStyle = rgba(palette.secondary, 0.95);
      ctx.beginPath();
      ctx.ellipse(p.x, boardY, unit * 0.52, unit * 0.13, 0, 0, TAU);
      ctx.fill();
      // Thruster glow underneath.
      const jet = ctx.createRadialGradient(p.x, boardY + unit * 0.1, 0,
                                           p.x, boardY + unit * 0.1, unit * 0.5);
      jet.addColorStop(0, rgba(palette.primary, 0.6));
      jet.addColorStop(1, rgba(palette.primary, 0));
      ctx.fillStyle = jet;
      ctx.beginPath();
      ctx.arc(p.x, boardY + unit * 0.1, unit * 0.5, 0, TAU);
      ctx.fill();
    }

    // --- body ---
    // A stylised humanoid built from a few primitives. Deliberately simple:
    // at speed the silhouette and pose are what the player actually reads.
    const lean = player.leanX * 0.28;
    const bob = player.bob * unit;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(lean * -0.5);

    if (pose === POSE.SLIDE) {
      this._drawPlayerSliding(ctx, unit, palette, player);
    } else if (pose === POSE.CRASH) {
      this._drawPlayerCrashed(ctx, unit, palette, state.time);
    } else {
      this._drawPlayerUpright(ctx, unit, palette, player, pose, bob);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _drawPlayerUpright(ctx, unit, palette, player, pose, bob) {
    const stride = player.stride;
    const airborne = pose === POSE.JUMP || pose === POSE.FALL;

    const hipY = -unit * 0.86 - bob;
    const shoulderY = -unit * 1.5 - bob;
    const headY = -unit * 1.66 - bob;

    const limb = Math.max(1.2, unit * 0.1);
    ctx.lineCap = 'round';

    // Legs
    ctx.strokeStyle = palette.secondary;
    ctx.lineWidth = limb;
    if (airborne) {
      // Tucked in the air.
      ctx.beginPath();
      ctx.moveTo(0, hipY);
      ctx.lineTo(-unit * 0.2, hipY + unit * 0.42);
      ctx.lineTo(-unit * 0.06, hipY + unit * 0.78);
      ctx.moveTo(0, hipY);
      ctx.lineTo(unit * 0.24, hipY + unit * 0.34);
      ctx.lineTo(unit * 0.3, hipY + unit * 0.7);
      ctx.stroke();
    } else {
      const swing = stride * unit * 0.34;
      ctx.beginPath();
      ctx.moveTo(0, hipY);
      ctx.lineTo(swing, hipY + unit * 0.46);
      ctx.lineTo(swing * 0.6, hipY + unit * 0.86);
      ctx.moveTo(0, hipY);
      ctx.lineTo(-swing, hipY + unit * 0.46);
      ctx.lineTo(-swing * 0.6, hipY + unit * 0.86);
      ctx.stroke();
    }

    // Torso
    const torso = ctx.createLinearGradient(0, shoulderY, 0, hipY);
    torso.addColorStop(0, palette.primary);
    torso.addColorStop(1, palette.secondary);
    ctx.fillStyle = torso;
    ctx.beginPath();
    ctx.moveTo(-unit * 0.26, shoulderY);
    ctx.lineTo(unit * 0.26, shoulderY);
    ctx.lineTo(unit * 0.19, hipY);
    ctx.lineTo(-unit * 0.19, hipY);
    ctx.closePath();
    ctx.fill();

    // Arms
    ctx.strokeStyle = palette.primary;
    ctx.lineWidth = limb * 0.85;
    if (airborne) {
      ctx.beginPath();
      ctx.moveTo(-unit * 0.2, shoulderY + unit * 0.05);
      ctx.lineTo(-unit * 0.46, shoulderY - unit * 0.26);
      ctx.moveTo(unit * 0.2, shoulderY + unit * 0.05);
      ctx.lineTo(unit * 0.5, shoulderY - unit * 0.18);
      ctx.stroke();
    } else {
      const armSwing = -stride * unit * 0.3;
      ctx.beginPath();
      ctx.moveTo(-unit * 0.2, shoulderY + unit * 0.05);
      ctx.lineTo(-unit * 0.2 + armSwing, shoulderY + unit * 0.4);
      ctx.moveTo(unit * 0.2, shoulderY + unit * 0.05);
      ctx.lineTo(unit * 0.2 - armSwing, shoulderY + unit * 0.4);
      ctx.stroke();
    }

    // Head + visor
    ctx.fillStyle = '#f3e2d0';
    ctx.beginPath();
    ctx.arc(0, headY, unit * 0.19, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(palette.primary, 0.95);
    ctx.beginPath();
    ctx.ellipse(unit * 0.05, headY - unit * 0.02, unit * 0.16, unit * 0.09, 0, 0, TAU);
    ctx.fill();

    // Backpack accent.
    ctx.fillStyle = palette.secondary;
    ctx.fillRect(-unit * 0.3, shoulderY + unit * 0.08, unit * 0.11, unit * 0.36);
  }

  _drawPlayerSliding(ctx, unit, palette, player) {
    const limb = Math.max(1.2, unit * 0.1);
    ctx.lineCap = 'round';

    // Body laid back, low to the ground.
    const bodyY = -unit * 0.34;
    const torso = ctx.createLinearGradient(-unit * 0.5, 0, unit * 0.4, 0);
    torso.addColorStop(0, palette.secondary);
    torso.addColorStop(1, palette.primary);
    ctx.fillStyle = torso;
    ctx.beginPath();
    ctx.ellipse(0, bodyY, unit * 0.5, unit * 0.24, -0.12, 0, TAU);
    ctx.fill();

    // Trailing legs.
    ctx.strokeStyle = palette.secondary;
    ctx.lineWidth = limb;
    ctx.beginPath();
    ctx.moveTo(-unit * 0.3, bodyY + unit * 0.05);
    ctx.lineTo(-unit * 0.72, bodyY + unit * 0.16);
    ctx.moveTo(-unit * 0.3, bodyY + unit * 0.12);
    ctx.lineTo(-unit * 0.66, bodyY + unit * 0.26);
    ctx.stroke();

    // Head, tucked forward.
    ctx.fillStyle = '#f3e2d0';
    ctx.beginPath();
    ctx.arc(unit * 0.42, bodyY - unit * 0.1, unit * 0.17, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(palette.primary, 0.95);
    ctx.beginPath();
    ctx.ellipse(unit * 0.47, bodyY - unit * 0.12, unit * 0.14, unit * 0.08, 0, 0, TAU);
    ctx.fill();

    // Friction sparks at the contact point.
    ctx.strokeStyle = rgba('#ffd23e', 0.7);
    ctx.lineWidth = Math.max(1, unit * 0.03);
    for (let i = 0; i < 3; i++) {
      const sx = -unit * (0.4 + Math.random() * 0.5);
      ctx.beginPath();
      ctx.moveTo(sx, -unit * 0.04);
      ctx.lineTo(sx - unit * 0.2, -unit * 0.04 - Math.random() * unit * 0.14);
      ctx.stroke();
    }
  }

  _drawPlayerCrashed(ctx, unit, palette, time) {
    // Slumped, rotating slightly - reads as "wiped out".
    ctx.rotate(Math.sin(time * 2) * 0.1 - 0.5);
    ctx.fillStyle = palette.secondary;
    ctx.beginPath();
    ctx.ellipse(0, -unit * 0.3, unit * 0.42, unit * 0.26, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#f3e2d0';
    ctx.beginPath();
    ctx.arc(unit * 0.34, -unit * 0.42, unit * 0.18, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = palette.primary;
    ctx.lineWidth = Math.max(1.2, unit * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-unit * 0.2, -unit * 0.2);
    ctx.lineTo(-unit * 0.6, -unit * 0.5);
    ctx.moveTo(-unit * 0.1, -unit * 0.35);
    ctx.lineTo(-unit * 0.3, -unit * 0.75);
    ctx.stroke();
  }

  // =========================================================================
  // Telegraphs & world-space text
  // =========================================================================

  /** Warning chevrons for incoming express trains. */
  _drawWarnings(state) {
    const ctx = this.ctx;
    const cam = this.camera;

    for (const h of state.world.hazards) {
      if (h.kind !== HAZARD.EXPRESS) continue;
      const distance = h.z - state.player.z;
      // Only warn while it is far enough to react to.
      if (distance < 22 || distance > 150) continue;

      const p = cam.project(h.x, 2.4, state.player.z + 20);
      if (!p.visible) continue;

      const flash = (Math.sin(state.time * 11) + 1) * 0.5;
      const alpha = clamp01(remap(distance, 150, 30, 0.15, 1)) * (0.45 + flash * 0.55);
      const size = p.scale * 0.5;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ff4d5e';
      // Triple chevron pointing at the threatened lane.
      for (let i = 0; i < 3; i++) {
        const oy = -i * size * 0.45;
        ctx.beginPath();
        ctx.moveTo(p.x - size * 0.5, p.y + oy);
        ctx.lineTo(p.x, p.y + oy + size * 0.36);
        ctx.lineTo(p.x + size * 0.5, p.y + oy);
        ctx.lineTo(p.x, p.y + oy + size * 0.12);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Floating score popups anchored in the world. */
  _drawPopups(state) {
    const ctx = this.ctx;
    if (!state.popups.length) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const popup of state.popups) {
      const life = clamp01(popup.life / FX.popupLife);
      const rise = (1 - life) * 1.8;
      const p = this.camera.project(popup.x, popup.y + rise, popup.z);
      if (!p.visible) continue;

      const size = clamp(p.scale * 0.34, 11, 40);
      ctx.globalAlpha = life * this.fogAlpha(p.depth);
      ctx.font = `800 ${Math.round(size)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, size * 0.16);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(popup.text, p.x, p.y);
      ctx.fillStyle = popup.color;
      ctx.fillText(popup.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // =========================================================================
  // Screen-space overlays
  // =========================================================================

  _drawOverlays(state) {
    const ctx = this.ctx;

    // Speed lines at high velocity: drawn in screen space so they read as
    // camera motion blur rather than world geometry.
    const intensity = state.speedRatio;
    if (intensity > 0.35 && !state.reducedMotion) {
      const count = Math.round(intensity * 16);
      ctx.strokeStyle = `rgba(180, 230, 255, ${(intensity - 0.35) * 0.28})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        // Deterministic pseudo-random placement, animated by time.
        const seed = (i * 2654435761) % 1000 / 1000;
        const angle = seed * TAU + state.time * 0.4;
        const radius = this.height * (0.36 + ((i * 7) % 10) / 22);
        const x = this.camera.cx + Math.cos(angle) * radius * 1.5;
        const y = this.camera.cy + Math.sin(angle) * radius;
        const len = 30 + intensity * 90;
        const dx = (x - this.camera.cx) * 0.0018;
        const dy = (y - this.camera.cy) * 0.0018;
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx * len, y + dy * len);
      }
      ctx.stroke();
    }

    // Turbo colour wash.
    if (state.powers.turbo > 0) {
      const pulse = 0.06 + Math.sin(state.time * 9) * 0.02;
      ctx.fillStyle = rgba(POWER_DEFS.turbo.color, pulse);
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Damage flash (shield hit / crash).
    if (state.hitFlash > 0) {
      ctx.fillStyle = `rgba(255, 70, 90, ${state.hitFlash * 0.45})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Pickup flash (power-up collected).
    if (state.pickupFlash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${state.pickupFlash * 0.22})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // Vignette last, to focus the eye centre-frame.
    if (this._vignette) {
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }
}
