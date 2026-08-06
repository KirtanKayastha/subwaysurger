/**
 * Small math / utility helpers shared across the engine.
 *
 * Deliberately dependency-free and allocation-light: several of these run
 * thousands of times per frame, so they avoid creating objects.
 */

// ---------------------------------------------------------------------------
// Scalar math
// ---------------------------------------------------------------------------

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Inverse lerp: where does `v` sit between a and b (unclamped)? */
export const invLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));

/** Remap `v` from one range to another, clamped to the output range. */
export const remap = (v, inMin, inMax, outMin, outMax) =>
  lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));

/**
 * Frame-rate independent exponential smoothing.
 *
 * `rate` is roughly "how many e-foldings per second"; higher = snappier.
 * Using 1 - exp(-rate * dt) instead of a raw factor keeps behaviour identical
 * at 30, 60 and 144 fps.
 */
export const damp = (current, target, rate, dt) =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Smooth Hermite interpolation between 0 and 1. */
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Even smoother (zero 1st & 2nd derivatives at both ends). */
export const smootherstep = (t) => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Ease-out cubic - good default for UI and camera motion. */
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);

/** Ease-out elastic-ish overshoot, used for pickup pops. */
export const easeOutBack = (t, overshoot = 1.7) => {
  const x = clamp01(t) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
};

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Randomness (seeded)
// ---------------------------------------------------------------------------

/**
 * Mulberry32 PRNG.
 *
 * A seeded generator matters here: the server hands the client a seed at run
 * start, so a given run is reproducible for debugging or future replay
 * verification. Returns a function producing floats in [0, 1).
 */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Uniform float in [min, max). */
  rng.range = (min, max) => min + rng() * (max - min);
  /** Uniform integer in [min, max] inclusive. */
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  /** Random element of an array. */
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** True with probability p. */
  rng.chance = (p) => rng() < p;
  /**
   * Weighted pick from `[[value, weight], ...]`.
   * Returns null for an empty or zero-weight list.
   */
  rng.weighted = (pairs) => {
    let total = 0;
    for (let i = 0; i < pairs.length; i++) total += pairs[i][1];
    if (total <= 0) return null;
    let roll = rng() * total;
    for (let i = 0; i < pairs.length; i++) {
      roll -= pairs[i][1];
      if (roll <= 0) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  };
  /** Fisher-Yates shuffle, in place. */
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/**
 * Axis-aligned box overlap in 3D.
 *
 * Boxes are given as centre + half-extents on each axis, which is how both the
 * player and hazards are stored, so no conversion is needed at call time.
 */
export function boxesOverlap(
  ax, ay, az, ahx, ahy, ahz,
  bx, by, bz, bhx, bhy, bhz,
) {
  return (
    Math.abs(ax - bx) < ahx + bhx &&
    Math.abs(ay - by) < ahy + bhy &&
    Math.abs(az - bz) < ahz + bhz
  );
}

/** Squared 2D distance - avoids a sqrt in hot loops. */
export const dist2 = (x1, y1, x2, y2) => {
  const dx = x1 - x2, dy = y1 - y2;
  return dx * dx + dy * dy;
};

/** Squared 3D distance. */
export const dist3 = (x1, y1, z1, x2, y2, z2) => {
  const dx = x1 - x2, dy = y1 - y2, dz = z1 - z2;
  return dx * dx + dy * dy + dz * dz;
};

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Parse `#rgb` / `#rrggbb` into `[r, g, b]` (0-255). Returns black on junk. */
export function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba()` string from a hex colour plus alpha. */
export function rgba(hex, alpha = 1) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Blend two hex colours; `t=0` -> a, `t=1` -> b. Returns an `rgb()` string. */
export function mixHex(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const k = clamp01(t);
  return `rgb(${Math.round(lerp(r1, r2, k))},${Math.round(lerp(g1, g2, k))},${Math.round(lerp(b1, b2, k))})`;
}

/** Lighten/darken a hex colour by `amount` in [-1, 1]. */
export function shade(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const f = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return `rgb(${Math.round(lerp(r, f, t))},${Math.round(lerp(g, f, t))},${Math.round(lerp(b, f, t))})`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Thousands-separated integer, e.g. `1234567` -> `"1,234,567"`. */
export const formatNumber = (n) =>
  Math.floor(Number(n) || 0).toLocaleString('en-US');

/** Compact score for tight spaces: `12500` -> `"12.5K"`. */
export function formatCompact(n) {
  const v = Math.floor(Number(n) || 0);
  if (v < 10000) return formatNumber(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 1e5 ? 1 : 0) + 'K';
  return (v / 1e6).toFixed(1) + 'M';
}

/** Distance in metres -> `"842 m"` / `"1.24 km"`. */
export function formatDistance(m) {
  const v = Math.max(0, Number(m) || 0);
  return v < 1000 ? `${Math.floor(v)} m` : `${(v / 1000).toFixed(2)} km`;
}

/** Milliseconds -> `m:ss`. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Epoch ms -> short relative string (`"3m ago"`). */
export function formatAgo(ms) {
  const delta = Date.now() - (Number(ms) || 0);
  if (delta < 60e3) return 'just now';
  if (delta < 3600e3) return `${Math.floor(delta / 60e3)}m ago`;
  if (delta < 86400e3) return `${Math.floor(delta / 3600e3)}h ago`;
  return `${Math.floor(delta / 86400e3)}d ago`;
}

// ---------------------------------------------------------------------------
// Storage (defensive)
// ---------------------------------------------------------------------------

/**
 * localStorage can throw: Safari private mode, disabled cookies, quota. Every
 * access is wrapped so persistence failure degrades to "no save" rather than
 * breaking the game.
 */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); return true; } catch { return false; }
  },
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Object pool: reuses instances to keep GC pauses out of the frame budget. */
export class Pool {
  constructor(factory, reset, initial = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }

  acquire() {
    return this.free.length ? this.free.pop() : this.factory();
  }

  release(item) {
    this.reset(item);
    this.free.push(item);
  }
}

/** Trailing-edge debounce. */
export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** True when the user has asked for reduced motion. */
export const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Short-lived vibration, if the device supports it and it is enabled. */
export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* not supported - silently ignore */ }
}
