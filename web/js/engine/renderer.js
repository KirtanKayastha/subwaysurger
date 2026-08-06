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

    // Test hook: render the scene without the character so the animation
    // harness can isolate the body by differencing two frames.
    if (state.hidePlayer) return;

    // projectNew (not project) because `project` returns a shared scratch
    // object: every later call would clobber this one, and the body would be
    // drawn at the shadow's position.
    const p = cam.projectNew(player.x, player.y, player.z);
    if (!p.visible) return;

    const scale = p.scale;
    const unit = scale;                       // pixels per metre at the runner
    const pose = player.pose;
    const alpha = player.invuln > 0 ? player.blink : 1;

    // --- contact shadow ---
    // Anchored to the ground beneath the runner, shrinking as they rise, which
    // is the main visual cue for jump height.
    const groundY = Number.isFinite(player.groundY) ? player.groundY : 0;
    const shadow = cam.projectNew(player.x, groundY + 0.01, player.z);
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
      this._drawPlayerCrashed(ctx, unit, palette, player);
    } else {
      this._drawPlayerUpright(ctx, unit, palette, player, pose, bob,
                              cam, p, lean, 1, 1);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // =========================================================================
  // Character rig
  // =========================================================================
  //
  // The runner is drawn procedurally from trig curves rather than sprite
  // sheets, so every pose blends continuously and scales to any resolution.
  //
  // Conventions inside the rig: origin is at the feet, -y is up, and `u` is
  // pixels-per-metre. Limbs are two-segment (hip->knee->foot) so they bend
  // like real joints instead of pivoting as rigid sticks.

  /**
   * Draw a two-segment limb and return the end-effector position.
   *
   * `a1` swings the upper segment, `a2` bends the lower one relative to it.
   * Angles are radians, measured from straight-down.
   */
  _limb(ctx, x, y, len1, len2, a1, a2, w, color) {
    const kx = x + Math.sin(a1) * len1;
    const ky = y + Math.cos(a1) * len1;
    const fx = kx + Math.sin(a1 + a2) * len2;
    const fy = ky + Math.cos(a1 + a2) * len2;

    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(kx, ky);
    ctx.lineTo(fx, fy);
    ctx.stroke();

    return { kx, ky, fx, fy };
  }

  /**
   * Head, drawn for a REAR view: the camera is behind the runner, so we see
   * the back of the skull and hair - never a face or a side-on visor.
   * `turn` shifts a sliver of visor into view when the runner leans.
   */
  _head(ctx, x, y, r, palette, turn = 0) {
    ctx.save();
    ctx.translate(x, y);

    // Skull.
    ctx.fillStyle = '#f3e2d0';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // Hair covering the back of the head, which is most of what we see.
    ctx.fillStyle = palette.secondary;
    ctx.beginPath();
    ctx.arc(0, -r * 0.12, r * 0.94, Math.PI * 0.08, Math.PI * 0.92, false);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.42, r * 0.86, r * 0.6, 0, 0, TAU);
    ctx.fill();

    // Headphone band + cups: reads instantly at small sizes and gives the
    // silhouette a recognisable shape from behind.
    ctx.strokeStyle = palette.primary;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.arc(0, -r * 0.05, r * 0.9, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
    ctx.fillStyle = palette.primary;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * r * 0.9, r * 0.05, r * 0.2, r * 0.3, 0, 0, TAU);
      ctx.fill();
    }

    // A hint of visor edge when turning, so the head still reads as 3D.
    if (Math.abs(turn) > 0.02) {
      ctx.fillStyle = rgba(palette.primary, Math.min(0.8, Math.abs(turn) * 3));
      ctx.beginPath();
      ctx.ellipse(Math.sign(turn) * r * 0.72, r * 0.05,
                  r * 0.22, r * 0.34, 0, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Running / airborne pose.
   *
   * Legs and arms are driven by one shared phase so they stay in sync: the
   * arms swing in opposition to the legs, exactly as in a real gait cycle.
   */
  _drawPlayerUpright(ctx, u, palette, player, pose, bob, cam, p, lean, sx0, sy0) {
    const airborne = pose === POSE.JUMP || pose === POSE.FALL;
    const t = player.runCycle;

    // --- squash & stretch --------------------------------------------------
    // Landing compresses the body; takeoff elongates it. Volume is roughly
    // preserved (x scales inversely to y) so the character never looks fat.
    const sq = player.squash;
    const st = player.stretch;
    const sy = 1 - sq * 0.22 + st * 0.14;
    const sx = 1 + sq * 0.18 - st * 0.10;
    ctx.scale(sx, sy);

    // Body pitch through the jump arc.
    if (airborne) ctx.rotate(player.pitch);

    const hipY = -u * (0.86 + bob / u);
    const shoulderY = -u * 1.5 - bob;
    const headY = -u * 1.72 - bob;
    const thigh = u * 0.44;
    const shin = u * 0.42;
    const upperArm = u * 0.32;
    const foreArm = u * 0.30;
    const legW = Math.max(1.4, u * 0.13);
    const armW = Math.max(1.2, u * 0.10);

    if (airborne) {
      // --- airborne: asymmetric tuck ---------------------------------------
      // Rising = legs tucked up; falling = front leg reaching for the ground.
      const rise = clamp01(player.vy / 10);
      const fall = 1 - rise;

      // Trailing leg stays tucked throughout.
      this._limb(ctx, -u * 0.08, hipY, thigh, shin,
                 -0.85 - rise * 0.5, 1.5 + rise * 0.6, legW, palette.secondary);
      // Leading leg extends as we descend, ready to land.
      this._limb(ctx, u * 0.08, hipY, thigh, shin,
                 0.55 + fall * 0.5, 0.75 - fall * 0.6, legW, palette.secondary);

      this._torso(ctx, u, palette, shoulderY, hipY);

      // Arms up and out for balance.
      this._limb(ctx, -u * 0.2, shoulderY + u * 0.04, upperArm, foreArm,
                 -2.3 + rise * 0.3, -0.7, armW, palette.primary);
      this._limb(ctx, u * 0.2, shoulderY + u * 0.04, upperArm, foreArm,
                 2.5 - rise * 0.3, 0.7, armW, palette.primary);

      this._head(ctx, 0, headY, u * 0.2, palette, player.pitch * 0.4);
      return;
    }

    // --- grounded run cycle -------------------------------------------------
    // Rear view: a stride reads as depth + foot lift, so each foot is projected
    // as a real world-space offset. That makes the trailing foot shrink and the
    // leading foot grow, which is what actually sells 3D from behind.
    const g = player.gait;

    const foot = (side, lg) => {
      // Hip in world space, then the foot offset in metres.
      const hipWorldY = player.y + 0.86;
      const hipX = player.x + side * 0.17;
      // Splay keeps the two legs visually separate from directly behind.
      const px = hipX + side * 0.10 + (lg.side || 0) * side;
      const fz = player.z + lg.reach;
      const fy = player.y + lg.lift;

      const hip = cam.projectNew(hipX, hipWorldY, player.z);
      const end = cam.projectNew(px, fy, fz);
      return { hip, end, depth: lg.reach };
    };

    // Draw the trailing leg first so the leading leg overlaps it.
    const order = g.legL.reach < g.legR.reach
      ? [[-1, g.legL, palette.secondary], [1, g.legR, palette.primary]]
      : [[1, g.legR, palette.secondary], [-1, g.legL, palette.primary]];

    ctx.restore();   // leave the local body transform to draw in screen space
    for (const [side, lg, color] of order) {
      const f = foot(side, lg);
      if (!f.hip.visible || !f.end.visible) continue;
      // Knee sits between hip and foot, pushed out by the bend amount.
      const mx = (f.hip.x + f.end.x) / 2 + side * u * 0.04;
      const my = (f.hip.y + f.end.y) / 2 + lg.bend * u * 0.16;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.4, u * 0.13);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(f.hip.x, f.hip.y);
      ctx.quadraticCurveTo(mx, my, f.end.x, f.end.y);
      ctx.stroke();
      // Shoe: a small blob that grows as the foot comes toward the camera.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(f.end.x, f.end.y, u * 0.11, u * 0.07, 0, 0, TAU);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(lean * -0.5);
    ctx.scale(sx, sy);

    this._torso(ctx, u, palette, shoulderY, hipY, g.twist);

    // --- arms -------------------------------------------------------------
    // From behind, an arm swinging forward mostly gets SHORTER and rises; it
    // does not sweep sideways. So `reach` drives vertical position and length
    // rather than rotation, which is what makes the gait read as 3D.
    const arm = (side, a) => {
      const sx2 = side * u * 0.24;
      const sy2 = shoulderY + u * 0.05;
      const fore = a.reach;
      const len = u * (0.66 - Math.abs(fore) * 0.16);
      // Hands stay clear of the torso silhouette so the swing is readable.
      const handX = sx2 + side * u * (0.16 + fore * 0.10);
      const handY = sy2 + len - fore * u * 0.34;
      const elbowX = sx2 + side * u * 0.26;
      const elbowY = sy2 + len * 0.55 - fore * u * 0.14;

      ctx.strokeStyle = palette.primary;
      ctx.lineWidth = armW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sx2, sy2);
      ctx.quadraticCurveTo(elbowX, elbowY, handX, handY);
      ctx.stroke();

      // Hand: grows slightly as it swings toward the camera.
      ctx.fillStyle = '#f3e2d0';
      ctx.beginPath();
      ctx.arc(handX, handY, u * (0.08 - fore * 0.02), 0, TAU);
      ctx.fill();
    };
    arm(-1, g.armL);
    arm(1, g.armR);

    // Head counter-bobs slightly against the torso, which reads as weight.
    this._head(ctx, g.twist * u * 0.35, headY + Math.sin(t * 2) * u * 0.015,
               u * 0.2, palette, g.twist);
  }

  /**
   * Shared torso wedge + backpack.
   * `twist` shears the shoulders slightly to suggest counter-rotation.
   */
  _torso(ctx, u, palette, shoulderY, hipY, twist = 0) {
    const sh = twist * u * 0.18;

    const grad = ctx.createLinearGradient(0, shoulderY, 0, hipY);
    grad.addColorStop(0, palette.primary);
    grad.addColorStop(1, palette.secondary);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-u * 0.27 + sh, shoulderY);
    ctx.lineTo(u * 0.27 + sh, shoulderY);
    ctx.lineTo(u * 0.2, hipY);
    ctx.lineTo(-u * 0.2, hipY);
    ctx.closePath();
    ctx.fill();

    // Backpack, centred on the back - the main thing visible from behind.
    ctx.fillStyle = palette.secondary;
    const bw = u * 0.3, bh = u * 0.44;
    const bx = -bw / 2 + sh * 0.6, by = shoulderY + u * 0.1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, u * 0.07);
    else ctx.rect(bx, by, bw, bh);
    ctx.fill();

    // Straps + a highlight so the pack does not read as a flat slab.
    ctx.strokeStyle = rgba(palette.primary, 0.55);
    ctx.lineWidth = Math.max(1, u * 0.035);
    ctx.beginPath();
    ctx.moveTo(bx + bw * 0.28, by);
    ctx.lineTo(bx + bw * 0.28, by + bh);
    ctx.moveTo(bx + bw * 0.72, by);
    ctx.lineTo(bx + bw * 0.72, by + bh);
    ctx.stroke();
  }

  /**
   * Slide pose.
   *
   * `blend` (0..1) drives the whole crouch, so entering and leaving a slide is
   * a smooth transition rather than a snap between two poses.
   */
  _drawPlayerSliding(ctx, u, palette, player) {
    const b = clamp01(player.duckBlend);

    // Rotate the whole body toward horizontal and drop it toward the deck.
    ctx.translate(0, -u * 0.06 * (1 - b));
    ctx.rotate(-b * 0.34);

    const hipY = -u * (0.86 - b * 0.42);
    const shoulderY = -u * (1.5 - b * 0.72);
    const headY = -u * (1.72 - b * 0.86);
    const thigh = u * 0.44;
    const shin = u * 0.42;
    const legW = Math.max(1.4, u * 0.13);
    const armW = Math.max(1.2, u * 0.10);

    // Legs fold forward and flatten out as the crouch deepens.
    this._limb(ctx, -u * 0.05, hipY, thigh, shin,
               0.4 + b * 0.9, 0.5 + b * 1.0, legW, palette.secondary);
    this._limb(ctx, u * 0.05, hipY, thigh, shin,
               0.6 + b * 1.15, 0.35 + b * 0.9, legW, palette.primary);

    this._torso(ctx, u, palette, shoulderY, hipY);

    // Leading arm braces forward, trailing arm tucks back.
    this._limb(ctx, u * 0.16, shoulderY + u * 0.05, u * 0.32, u * 0.30,
               1.1 + b * 0.5, 0.5, armW, palette.primary);
    this._limb(ctx, -u * 0.16, shoulderY + u * 0.05, u * 0.32, u * 0.30,
               -1.5 - b * 0.6, -0.6, armW, palette.primary);

    this._head(ctx, u * 0.1 * b, headY, u * 0.2, palette, b * 0.3);

    // Friction sparks kick off the heels, scaled by how deep the slide is.
    if (b > 0.4) {
      ctx.strokeStyle = rgba('#ffd23e', 0.55 * b);
      ctx.lineWidth = Math.max(1, u * 0.03);
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const sx = -u * (0.3 + Math.random() * 0.5);
        ctx.moveTo(sx, -u * 0.04);
        ctx.lineTo(sx - u * (0.15 + Math.random() * 0.2),
                   -u * 0.04 - Math.random() * u * 0.16);
      }
      ctx.stroke();
    }
  }

  /**
   * Crash pose.
   *
   * Drives off `deathTime` rather than the global clock so the tumble always
   * starts from the same frame no matter when in the run you died.
   */
  _drawPlayerCrashed(ctx, u, palette, player) {
    const t = player.deathTime;
    // Tumble fast at first, then settle - like a body losing momentum.
    const settle = 1 - Math.exp(-t * 2.4);
    const rot = -0.4 - settle * 1.15 + Math.sin(t * 9) * 0.12 * (1 - settle);
    ctx.rotate(rot);

    const hipY = -u * 0.4;
    const shoulderY = -u * 0.95;
    const headY = -u * 1.15;
    const legW = Math.max(1.4, u * 0.13);
    const armW = Math.max(1.2, u * 0.10);

    // Limbs splayed at loose, asymmetric angles. Drawn as explicit curves in
    // local space (the world-space leg rig above assumes an upright runner and
    // would fight the tumble rotation).
    const sprawl = (x0, y0, dx, dy, w, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + dx * 0.5, y0 + dy * 0.35, x0 + dx, y0 + dy);
      ctx.stroke();
    };

    const wob = Math.sin(t * 7) * u * 0.06;
    // Legs.
    sprawl(-u * 0.08, hipY, -u * 0.52 + wob, u * 0.55, legW, palette.secondary);
    sprawl(u * 0.08, hipY, u * 0.62 - wob, u * 0.34, legW, palette.primary);

    this._torso(ctx, u, palette, shoulderY, hipY, 0);

    // Arms flung outward.
    sprawl(-u * 0.22, shoulderY + u * 0.06, -u * 0.55 - wob, -u * 0.26,
           armW, palette.primary);
    sprawl(u * 0.22, shoulderY + u * 0.06, u * 0.5 + wob, -u * 0.36,
           armW, palette.primary);

    this._head(ctx, 0, headY, u * 0.2, palette, 0);

    // Stun stars orbit the head for the first moment after the hit.
    if (t < 1.4) {
      const fade = clamp01(1.4 - t);
      ctx.fillStyle = rgba('#ffd23e', fade * 0.9);
      for (let i = 0; i < 3; i++) {
        const a = t * 6 + (i / 3) * TAU;
        const sx = Math.cos(a) * u * 0.42;
        const sy = headY - u * 0.34 + Math.sin(a) * u * 0.14;
        const r = u * 0.07;
        ctx.beginPath();
        // Four-point sparkle.
        for (let k = 0; k < 8; k++) {
          const ang = (k / 8) * TAU;
          const rad = k % 2 === 0 ? r : r * 0.42;
          const px = sx + Math.cos(ang) * rad;
          const py = sy + Math.sin(ang) * rad;
          k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
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

    // Hoverboard stock. Drawn on the canvas rather than in the React HUD so it
    // stays correct on the frame a board is spent, without waiting for a
    // re-render. Hidden outside a run and when the stock is empty.
    if (state.playing && state.hoverboards > 0) {
      this._drawBoardCount(state.hoverboards);
    }

    // Vignette last, to focus the eye centre-frame.
    if (this._vignette) {
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  /** Small "board x N" pill in the bottom-left safe area. */
  _drawBoardCount(count) {
    const ctx = this.ctx;
    const pad = 16;
    const h = 26;
    const y = this.height - pad - h;
    const label = `BOARD x${count}`;

    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + 34;

    ctx.fillStyle = 'rgba(5, 8, 20, 0.55)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(pad, y, w, h, 13);
    else ctx.rect(pad, y, w, h);
    ctx.fill();

    ctx.strokeStyle = 'rgba(34, 232, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Board glyph: a stubby ellipse, matching the one under the runner.
    ctx.fillStyle = '#22e8ff';
    ctx.beginPath();
    ctx.ellipse(pad + 15, y + h / 2, 8, 3, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(233, 240, 255, 0.92)';
    ctx.fillText(label, pad + 27, y + h / 2 + 1);
  }
}
