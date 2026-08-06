/**
 * Particle system.
 *
 * A single flat pool of 3D particles, drawn as projected quads/points. Design
 * constraints that shaped this:
 *
 *  * **Fixed capacity, zero allocation.** Particles are pre-allocated once and
 *    recycled via a free-list, so heavy effects never trigger a GC pause
 *    mid-run (the #1 cause of stutter in canvas games).
 *  * **Swap-remove.** Dead particles are removed by swapping with the last
 *    live element, keeping iteration over a dense array.
 *  * **World-space.** Particles live in world coordinates and are projected
 *    like everything else, so sparks correctly shrink with distance and sort
 *    against geometry.
 */

import { FX } from './constants.js';
import { clamp01, rgba, TAU } from './util.js';

/** Particle behaviour presets. */
export const PARTICLE = {
  SPARK: 'spark',     // fast, bright, gravity-affected streak
  DUST: 'dust',       // slow soft puff
  RING: 'ring',       // expanding circle outline
  SHARD: 'shard',     // rotating rectangle (debris)
  TRAIL: 'trail',     // fading dot left behind the player
  COIN: 'coin',       // small gold fleck
};

class Particle {
  constructor() {
    this.active = false;
    this.kind = PARTICLE.SPARK;
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.life = 0; this.maxLife = 1;
    this.size = 0.1;
    this.color = '#ffffff';
    this.gravity = -9;
    this.drag = 0;
    this.spin = 0;
    this.rotation = 0;
    this.fade = 1;      // starting alpha
  }
}

export class ParticleSystem {
  constructor(capacity = FX.maxParticles) {
    this.capacity = capacity;
    /** Dense array of live particles. */
    this.items = [];
    /** Recycled instances. */
    this.pool = [];
    for (let i = 0; i < capacity; i++) this.pool.push(new Particle());
  }

  get count() { return this.items.length; }

  clear() {
    while (this.items.length) this.pool.push(this.items.pop());
  }

  /**
   * Spawn one particle. Silently drops the request when the pool is exhausted,
   * which is the correct failure mode: effects degrade, frame rate does not.
   */
  spawn(options) {
    const p = this.pool.pop();
    if (!p) return null;

    p.active = true;
    p.kind = options.kind || PARTICLE.SPARK;
    p.x = options.x || 0;
    p.y = options.y || 0;
    p.z = options.z || 0;
    p.vx = options.vx || 0;
    p.vy = options.vy || 0;
    p.vz = options.vz || 0;
    p.maxLife = options.life || 0.5;
    p.life = p.maxLife;
    p.size = options.size || 0.12;
    p.color = options.color || '#ffffff';
    p.gravity = options.gravity ?? -9;
    p.drag = options.drag ?? 0.6;
    p.spin = options.spin || 0;
    p.rotation = options.rotation || 0;
    p.fade = options.fade ?? 1;

    this.items.push(p);
    return p;
  }

  /** Integrate all particles and retire the expired ones. */
  update(dt) {
    const items = this.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i];
      p.life -= dt;

      if (p.life <= 0) {
        // Swap-remove: O(1) and keeps the array dense.
        const last = items.length - 1;
        if (i !== last) items[i] = items[last];
        items.pop();
        p.active = false;
        this.pool.push(p);
        continue;
      }

      p.vy += p.gravity * dt;

      if (p.drag > 0) {
        // Exponential drag: frame-rate independent.
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vz *= k;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rotation += p.spin * dt;
    }
  }

  // -------------------------------------------------------------------------
  // Effect recipes
  // -------------------------------------------------------------------------

  /** Golden burst when a coin is collected. */
  coinBurst(x, y, z, color = '#ffd23e') {
    for (let i = 0; i < 7; i++) {
      const angle = Math.random() * TAU;
      const speed = 1.6 + Math.random() * 2.6;
      this.spawn({
        kind: PARTICLE.COIN, x, y, z, color,
        vx: Math.cos(angle) * speed,
        vy: 1.4 + Math.random() * 2.6,
        vz: Math.sin(angle) * speed * 0.5,
        life: 0.3 + Math.random() * 0.25,
        size: 0.05 + Math.random() * 0.05,
        gravity: -11, drag: 1.4,
      });
    }
  }

  /** Dust puff on landing; `strength` scales the count and spread. */
  landingDust(x, y, z, strength = 1) {
    const count = Math.round(5 + strength * 7);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const speed = (0.8 + Math.random() * 1.8) * strength;
      this.spawn({
        kind: PARTICLE.DUST, x, y: y + 0.05, z,
        color: '#7d8fb5',
        vx: Math.cos(angle) * speed,
        vy: 0.4 + Math.random() * 1.0,
        vz: Math.sin(angle) * speed * 0.6 - 2,
        life: 0.3 + Math.random() * 0.35,
        size: 0.14 + Math.random() * 0.2,
        gravity: -2.2, drag: 2.4, fade: 0.5,
      });
    }
  }

  /** Continuous footfall scuff while running. */
  footstep(x, y, z, color) {
    this.spawn({
      kind: PARTICLE.DUST, x: x + (Math.random() - 0.5) * 0.4, y: y + 0.04, z,
      color,
      vx: (Math.random() - 0.5) * 0.8,
      vy: 0.3 + Math.random() * 0.5,
      vz: -3 - Math.random() * 2,
      life: 0.22, size: 0.09, gravity: -1.5, drag: 2, fade: 0.35,
    });
  }

  /** Speed streaks trailing the runner, used at high velocity / turbo. */
  speedTrail(x, y, z, color, speed) {
    this.spawn({
      kind: PARTICLE.TRAIL,
      x: x + (Math.random() - 0.5) * 1.0,
      y: y + 0.4 + Math.random() * 1.2,
      z: z - 0.4,
      color,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.4,
      vz: -speed * 0.32,
      life: 0.22 + Math.random() * 0.16,
      size: 0.05 + Math.random() * 0.07,
      gravity: 0, drag: 0, fade: 0.75,
    });
  }

  /** Big multi-layer explosion for a fatal crash. */
  explosion(x, y, z, color = '#ff4d5e') {
    // Bright core sparks.
    for (let i = 0; i < 26; i++) {
      const angle = Math.random() * TAU;
      const pitch = Math.random() * Math.PI - Math.PI / 2;
      const speed = 3 + Math.random() * 9;
      this.spawn({
        kind: PARTICLE.SPARK, x, y, z, color: i % 3 === 0 ? '#ffffff' : color,
        vx: Math.cos(angle) * Math.cos(pitch) * speed,
        vy: Math.sin(pitch) * speed + 2.5,
        vz: Math.sin(angle) * Math.cos(pitch) * speed * 0.6,
        life: 0.45 + Math.random() * 0.6,
        size: 0.07 + Math.random() * 0.1,
        gravity: -14, drag: 0.8, spin: (Math.random() - 0.5) * 12,
      });
    }
    // Tumbling debris.
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * TAU;
      const speed = 2 + Math.random() * 5;
      this.spawn({
        kind: PARTICLE.SHARD, x, y, z, color,
        vx: Math.cos(angle) * speed,
        vy: 2 + Math.random() * 5,
        vz: Math.sin(angle) * speed * 0.5,
        life: 0.7 + Math.random() * 0.7,
        size: 0.12 + Math.random() * 0.16,
        gravity: -18, drag: 0.4, spin: (Math.random() - 0.5) * 18,
        rotation: Math.random() * TAU,
      });
    }
    // Shock ring.
    this.spawn({
      kind: PARTICLE.RING, x, y, z, color: '#ffffff',
      life: 0.4, size: 0.4, gravity: 0, drag: 0, vy: 0,
    });
  }

  /** Radiant pop when a power-up is grabbed. */
  powerBurst(x, y, z, color) {
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * TAU;
      const speed = 3.5 + Math.random() * 2.5;
      this.spawn({
        kind: PARTICLE.SPARK, x, y, z, color,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.7 + 1,
        vz: (Math.random() - 0.5) * 2,
        life: 0.4 + Math.random() * 0.3,
        size: 0.08, gravity: -6, drag: 1.2,
      });
    }
    this.spawn({
      kind: PARTICLE.RING, x, y, z, color, life: 0.45, size: 0.3,
      gravity: 0, drag: 0,
    });
  }

  /** Shield absorbing an impact: an inward-collapsing flash. */
  shieldHit(x, y, z, color = '#22e8ff') {
    for (let i = 0; i < 22; i++) {
      const angle = (i / 22) * TAU;
      this.spawn({
        kind: PARTICLE.SPARK, x, y, z, color,
        vx: Math.cos(angle) * 6,
        vy: Math.sin(angle) * 4 + 1,
        vz: (Math.random() - 0.5) * 3,
        life: 0.3, size: 0.09, gravity: -4, drag: 2.5,
      });
    }
    this.spawn({ kind: PARTICLE.RING, x, y, z, color, life: 0.35, size: 0.5, gravity: 0, drag: 0 });
  }

  /** Sparks kicked up when a shielded runner smashes through a hazard. */
  smash(x, y, z, color) {
    for (let i = 0; i < 16; i++) {
      const angle = Math.random() * TAU;
      const speed = 2 + Math.random() * 7;
      this.spawn({
        kind: PARTICLE.SHARD, x, y: y + Math.random() * 1.2, z, color,
        vx: Math.cos(angle) * speed,
        vy: 1 + Math.random() * 4,
        vz: Math.sin(angle) * speed * 0.4 - 4,
        life: 0.5 + Math.random() * 0.4,
        size: 0.1 + Math.random() * 0.14,
        gravity: -16, drag: 0.5, spin: (Math.random() - 0.5) * 20,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * Render every live particle.
   *
   * Particles are drawn without depth-sorting against world geometry: they are
   * additive highlights, so ordering artefacts are invisible, and skipping the
   * sort saves meaningful time when hundreds are alive.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./camera.js').Camera} camera
   * @param {(depth:number)=>number} fogAlpha distance->alpha multiplier
   */
  draw(ctx, camera, fogAlpha) {
    const items = this.items;
    if (!items.length) return;

    ctx.save();
    // Additive blending makes overlapping sparks glow instead of muddying.
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const proj = camera.project(p.x, p.y, p.z);
      if (!proj.visible) continue;

      const lifeRatio = clamp01(p.life / p.maxLife);
      const alpha = lifeRatio * p.fade * fogAlpha(proj.depth);
      if (alpha <= 0.01) continue;

      const radius = p.size * proj.scale;
      if (radius < 0.35) continue;   // sub-pixel: not worth a draw call

      ctx.globalAlpha = alpha;

      switch (p.kind) {
        case PARTICLE.RING: {
          // Rings expand over their lifetime rather than moving.
          const grow = (1 - lifeRatio) * 3.2 + p.size;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, 3 * lifeRatio * (proj.scale * 0.02));
          ctx.beginPath();
          ctx.arc(proj.x, proj.y, grow * proj.scale, 0, TAU);
          ctx.stroke();
          break;
        }
        case PARTICLE.SHARD: {
          ctx.save();
          ctx.translate(proj.x, proj.y);
          ctx.rotate(p.rotation);
          ctx.fillStyle = p.color;
          ctx.fillRect(-radius, -radius * 0.45, radius * 2, radius * 0.9);
          ctx.restore();
          break;
        }
        case PARTICLE.TRAIL: {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(proj.x, proj.y, radius * 0.7, radius * 2.4, 0, 0, TAU);
          ctx.fill();
          break;
        }
        case PARTICLE.SPARK: {
          // Stretch along the velocity direction for a motion-streak look.
          const streak = Math.min(3, Math.hypot(p.vx, p.vy) * 0.05);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(proj.x, proj.y, radius, radius * (1 + streak), 0, 0, TAU);
          ctx.fill();
          break;
        }
        default: {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(proj.x, proj.y, radius, 0, TAU);
          ctx.fill();
          break;
        }
      }
    }

    ctx.restore();
  }
}
