/**
 * Game-wide tuning constants.
 *
 * Everything that defines "feel" lives here so balance can be adjusted without
 * hunting through systems. World units are metres; the runner travels along
 * +Z, X is lateral, Y is up (0 = track surface).
 *
 * NOTE: the speed/scoring ceilings here must stay within the server's
 * plausibility envelope in `server/app/config.py` (PHYSICS), otherwise a
 * legitimate run could be rejected by the anti-cheat check.
 */

// ---------------------------------------------------------------------------
// Track geometry
// ---------------------------------------------------------------------------

/** Lateral offset between lane centres (metres). */
export const LANE_WIDTH = 2.6;

/** X position of each of the three lanes. */
export const LANE_X = [-LANE_WIDTH, 0, LANE_WIDTH];

/** Tunnel wall / ceiling placement. */
export const WALL_X = 6.4;
export const CEIL_Y = 6.2;

/** How far ahead entities are simulated & drawn (metres). */
export const VIEW_DISTANCE = 165;

/** Distance behind the camera at which entities are recycled. */
export const CULL_BEHIND = -14;

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAMERA = {
  /** Camera sits this far behind the runner. */
  back: 8.2,
  /** Eye height above the track. */
  height: 3.5,
  /** Vertical screen position of the vanishing point (fraction of height). */
  horizon: 0.44,
  /** Focal length as a multiple of the virtual viewport height. */
  focal: 1.05,
  /** How strongly the camera drifts toward the runner's lane (0..1). */
  followX: 0.55,
  /** Follow smoothing per second. */
  followSpeed: 6.5,
  /** Extra pull-back applied at full turbo, for a speed-rush feel. */
  turboBack: 2.6,
};

// ---------------------------------------------------------------------------
// Runner physics
// ---------------------------------------------------------------------------

export const PLAYER = {
  /** Collision box (metres). */
  width: 0.92,
  depth: 0.72,
  height: 1.78,
  /** Height while sliding - must clear GATE.clearance. */
  duckHeight: 0.85,

  /** Vertical launch speed and gravity. Apex ~2.0 m, airtime ~0.58 s. */
  jumpVelocity: 13.0,
  gravity: -42.0,
  /** Extra gravity while falling makes jumps feel snappy rather than floaty. */
  fallMultiplier: 1.35,
  /**
   * Jump height is FIXED, not variable.
   *
   * A tap is the natural touch gesture, so a release-to-cut jump would give
   * mobile players a much lower hop than desktop players holding the key -
   * low enough to fail to clear a barrier. Every obstacle here has a fixed
   * height and there is no precision platforming, so a consistent arc is both
   * fairer and more readable.
   */

  /** Seconds a slide lasts before auto-standing. */
  duckDuration: 0.62,

  /** Lane-change duration in seconds. */
  laneChangeTime: 0.13,

  /** Input buffer: an action pressed this early still registers on landing. */
  inputBuffer: 0.16,
  /** Coyote time: jump still works just after running off an edge. */
  coyoteTime: 0.09,

  /** Invulnerability window after a hoverboard save. */
  reviveInvuln: 2.4,
};

// ---------------------------------------------------------------------------
// Speed & difficulty progression
// ---------------------------------------------------------------------------

export const SPEED = {
  start: 15.0,
  max: 46.0,
  /** Metres per second gained per metre travelled (gentle logistic ramp). */
  rampDistance: 2600,
  /** Multiplier applied while turbo is active. */
  turboMultiplier: 1.62,
  /** How fast the actual speed eases toward the target (per second). */
  smoothing: 2.2,
};

export const DIFFICULTY = {
  /** Distance at which each new hazard type joins the spawn pool. */
  unlocks: {
    gate: 150,
    pylon: 320,
    train: 520,
    gap: 800,
    drone: 1150,
    express: 1600,
  },
  /**
   * Reaction budget: the generator keeps at least this many *seconds* between
   * hazard rows, so raising speed never makes the game unfair - only denser.
   */
  reactionEarly: 1.15,
  reactionLate: 0.78,
  /** Distance over which the reaction budget tightens to its floor. */
  reactionRamp: 4500,
  /** Minimum absolute spacing so rows never visually overlap. */
  minRowGap: 16,
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORE = {
  /** Points per metre travelled. */
  perMetre: 1.0,
  /** Base points per coin (raised by the Alloy Refinery upgrade). */
  perCoin: 10,
  /** Points for threading past a hazard at close range. */
  nearMiss: 25,
  /** Lateral/vertical tolerance that counts as a near miss (metres). */
  nearMissRange: 1.15,
  /** Combo: every N coins adds +1 to the multiplier. */
  comboStep: 8,
  comboMax: 8,
  /** Seconds of no pickups before the combo decays (raised by Flow State). */
  comboGrace: 2.2,
};

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

/** Canonical power-up identifiers. */
export const POWER = {
  MAGNET: 'magnet',
  SHIELD: 'shield',
  TURBO: 'turbo',
  DOUBLE: 'double',
};

export const POWER_DEFS = {
  [POWER.MAGNET]: {
    label: 'Magnet', color: '#a06bff', duration: 6.0,
    /** Radius within which coins are vacuumed in. */
    radius: 9.5, pullSpeed: 26,
  },
  [POWER.SHIELD]: {
    label: 'Shield', color: '#22e8ff', duration: 5.0,
  },
  [POWER.TURBO]: {
    label: 'Turbo', color: '#ff3ea5', duration: 4.0,
  },
  [POWER.DOUBLE]: {
    label: 'Score x2', color: '#ffd23e', duration: 9.0, multiplier: 2,
  },
};

/** Relative spawn weights for power-up crates. */
export const POWER_WEIGHTS = [
  [POWER.MAGNET, 30],
  [POWER.SHIELD, 26],
  [POWER.TURBO, 20],
  [POWER.DOUBLE, 24],
];

/** Metres between power-up spawn opportunities. */
export const POWER_SPACING = 620;

// ---------------------------------------------------------------------------
// Hazards
// ---------------------------------------------------------------------------

export const HAZARD = {
  /** Low barricade: jump it. */
  BARRIER: 'barrier',
  /** Overhead beam: slide under it. */
  GATE: 'gate',
  /** Full-height column: change lanes. */
  PYLON: 'pylon',
  /** Parked carriage: dodge, or land on the roof and run along it. */
  TRAIN: 'train',
  /** Oncoming express: telegraphed, unavoidable except by changing lanes. */
  EXPRESS: 'express',
  /** Missing track section: jump the void. */
  GAP: 'gap',
  /** Hovering drone that drifts between lanes. */
  DRONE: 'drone',
};

export const HAZARD_DEFS = {
  [HAZARD.BARRIER]: { height: 1.15, depth: 0.55, width: 2.1, color: '#ff3ea5', solid: true },
  // `clearance` is the empty space beneath the beam; the duck box must fit.
  [HAZARD.GATE]:    { height: 1.6, depth: 0.5, width: 2.4, clearance: 1.05, color: '#ffd23e' },
  [HAZARD.PYLON]:   { height: 3.4, depth: 0.8, width: 1.5, color: '#a06bff', solid: true },
  [HAZARD.TRAIN]:   { height: 2.0, depth: 22, width: 2.3, color: '#2f7de8', solid: true, rideable: true },
  [HAZARD.EXPRESS]: { height: 3.1, depth: 26, width: 2.35, color: '#ff4d5e', solid: true, speed: 34 },
  [HAZARD.GAP]:     { height: 0, depth: 6.5, width: 2.4, color: '#000000' },
  [HAZARD.DRONE]:   { height: 1.0, depth: 0.9, width: 1.3, base: 0.95, color: '#ff4d5e' },
};

// ---------------------------------------------------------------------------
// Collectibles
// ---------------------------------------------------------------------------

export const COIN = {
  radius: 0.34,
  /** Height above the track for a normal coin line. */
  height: 1.0,
  /** Spacing along Z within a coin run. */
  spacing: 1.7,
  /** Magnet capture distance. */
  pickupRadius: 0.95,
};

// ---------------------------------------------------------------------------
// Visual / feedback
// ---------------------------------------------------------------------------

export const FX = {
  maxParticles: 700,
  /** Screen-shake decay per second. */
  shakeDecay: 5.5,
  /** Fog colour the tunnel fades into at the far plane. */
  fogColor: '#070a18',
  /** Distance at which geometry is fully faded out. */
  fogStart: 55,
  fogEnd: 158,
  /** Score popups live this long. */
  popupLife: 0.9,
};

/** Player skin palettes (mirrors SKIN_CATALOG on the server). */
export const SKINS = {
  cyan:    { primary: '#22e8ff', secondary: '#0b7fa8', trail: '#22e8ff' },
  magenta: { primary: '#ff3ea5', secondary: '#8c1550', trail: '#ff3ea5' },
  lime:    { primary: '#b9ff2e', secondary: '#4f8c15', trail: '#b9ff2e' },
  gold:    { primary: '#ffd23e', secondary: '#8c6a15', trail: '#ffd23e' },
  void:    { primary: '#a06bff', secondary: '#4a2596', trail: '#c9a4ff' },
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Fixed physics step (seconds). Rendering interpolates between steps. */
export const FIXED_STEP = 1 / 120;

/** Never simulate more than this per frame - prevents spiral-of-death after
 *  a tab is backgrounded. */
export const MAX_FRAME_TIME = 0.25;

/** localStorage keys. */
export const STORAGE_KEYS = {
  token: 'neonrush.token',
  profile: 'neonrush.profile',
  settings: 'neonrush.settings',
  scores: 'neonrush.scores',
  missions: 'neonrush.missions',
  inventory: 'neonrush.inventory',
};
