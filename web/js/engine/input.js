/**
 * Unified input.
 *
 * Three sources (keyboard, touch, gamepad) are normalised into one small set of
 * intents that the game logic consumes:
 *
 *     left, right, jump, duck, pause, mute
 *
 * Two details that matter for game feel:
 *
 *  * **Buffering.** Actions are queued with a timestamp rather than read as
 *    "is the key down this instant". A jump pressed a few frames before landing
 *    still fires - this is what makes the controls feel responsive instead of
 *    dropping inputs.
 *  * **Swipe vs tap.** A touch is classified only once it exceeds a distance
 *    threshold, so a quick tap can be used for jump while a drag is a swipe.
 */

import { PLAYER } from './constants.js';

/** Intent names. */
export const ACTION = {
  LEFT: 'left',
  RIGHT: 'right',
  JUMP: 'jump',
  DUCK: 'duck',
};

/** Minimum travel (CSS px) before a touch counts as a swipe. */
const SWIPE_THRESHOLD = 26;
/** A touch shorter than this that never moved counts as a tap -> jump. */
const TAP_MAX_MS = 260;

export class InputManager {
  constructor() {
    /** Queued actions: `[{ action, time }]`, consumed by the game loop. */
    this.queue = [];
    /** Currently-held state, for continuous input like holding a slide. */
    this.held = { left: false, right: false, jump: false, duck: false };

    /** Callbacks the game/UI subscribe to. */
    this.onPause = null;
    this.onMute = null;
    this.onAnyInput = null;   // used to unlock audio on first gesture

    this._touch = null;       // active touch tracking state
    this._bound = false;
    this._gamepadPrev = {};   // edge detection for gamepad buttons

    // Bind once so add/removeEventListener see identical references.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Attach listeners.
   * @param {HTMLElement} surface element that receives touch events
   */
  attach(surface) {
    if (this._bound) return;
    this.surface = surface;

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    // `passive: false` is required so preventDefault can stop scroll/zoom.
    surface.addEventListener('touchstart', this._onTouchStart, { passive: false });
    surface.addEventListener('touchmove', this._onTouchMove, { passive: false });
    surface.addEventListener('touchend', this._onTouchEnd, { passive: false });
    surface.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
    surface.addEventListener('contextmenu', this._onContextMenu);

    this._bound = true;
  }

  detach() {
    if (!this._bound) return;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    const s = this.surface;
    s.removeEventListener('touchstart', this._onTouchStart);
    s.removeEventListener('touchmove', this._onTouchMove);
    s.removeEventListener('touchend', this._onTouchEnd);
    s.removeEventListener('touchcancel', this._onTouchEnd);
    s.removeEventListener('contextmenu', this._onContextMenu);
    this._bound = false;
  }

  // -------------------------------------------------------------------------
  // Queue API (consumed by the game loop)
  // -------------------------------------------------------------------------

  /** Record an intent with the current timestamp. */
  push(action) {
    this.queue.push({ action, time: performance.now() / 1000 });
    // Keep the buffer tiny; stale intents are useless.
    if (this.queue.length > 8) this.queue.shift();
    if (this.onAnyInput) this.onAnyInput();
  }

  /**
   * Remove and return the oldest still-valid action, or null.
   *
   * Entries older than `PLAYER.inputBuffer` are discarded, which is what makes
   * buffering forgiving without letting ancient presses fire.
   */
  consume() {
    const now = performance.now() / 1000;
    while (this.queue.length) {
      const entry = this.queue.shift();
      if (now - entry.time <= PLAYER.inputBuffer) return entry.action;
    }
    return null;
  }

  /** Peek whether a specific action is buffered (without consuming). */
  hasBuffered(action) {
    const now = performance.now() / 1000;
    return this.queue.some(
      (e) => e.action === action && now - e.time <= PLAYER.inputBuffer,
    );
  }

  clear() {
    this.queue.length = 0;
    this.held.left = this.held.right = this.held.jump = this.held.duck = false;
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  _onKeyDown(event) {
    // Let the browser handle typing in form fields.
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    const code = event.code;
    let handled = true;

    switch (code) {
      case 'ArrowLeft': case 'KeyA':
        if (!event.repeat) this.push(ACTION.LEFT);
        this.held.left = true;
        break;
      case 'ArrowRight': case 'KeyD':
        if (!event.repeat) this.push(ACTION.RIGHT);
        this.held.right = true;
        break;
      case 'ArrowUp': case 'KeyW': case 'Space':
        if (!event.repeat) this.push(ACTION.JUMP);
        this.held.jump = true;
        break;
      case 'ArrowDown': case 'KeyS':
        if (!event.repeat) this.push(ACTION.DUCK);
        this.held.duck = true;
        break;
      case 'Escape': case 'KeyP':
        if (!event.repeat && this.onPause) this.onPause();
        break;
      case 'KeyM':
        if (!event.repeat && this.onMute) this.onMute();
        break;
      default:
        handled = false;
    }

    // Stop arrows/space from scrolling the page mid-run.
    if (handled) event.preventDefault();
    if (handled && this.onAnyInput) this.onAnyInput();
  }

  _onKeyUp(event) {
    switch (event.code) {
      case 'ArrowLeft': case 'KeyA':  this.held.left = false; break;
      case 'ArrowRight': case 'KeyD': this.held.right = false; break;
      case 'ArrowUp': case 'KeyW': case 'Space': this.held.jump = false; break;
      case 'ArrowDown': case 'KeyS':  this.held.duck = false; break;
      default: break;
    }
  }

  /** Losing focus must release everything, or the player "sticks". */
  _onBlur() {
    this.clear();
  }

  _onContextMenu(event) {
    // Long-press on mobile otherwise pops a context menu over the game.
    event.preventDefault();
  }

  // -------------------------------------------------------------------------
  // Touch
  // -------------------------------------------------------------------------

  _onTouchStart(event) {
    event.preventDefault();
    const touch = event.changedTouches[0];
    if (!touch) return;
    this._touch = {
      id: touch.identifier,
      x0: touch.clientX,
      y0: touch.clientY,
      t0: performance.now(),
      fired: false,     // a swipe already dispatched for this gesture
    };
    if (this.onAnyInput) this.onAnyInput();
  }

  _onTouchMove(event) {
    event.preventDefault();
    const state = this._touch;
    if (!state || state.fired) return;

    const touch = Array.from(event.changedTouches)
      .find((t) => t.identifier === state.id);
    if (!touch) return;

    const dx = touch.clientX - state.x0;
    const dy = touch.clientY - state.y0;

    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;

    // Dominant axis wins, so a diagonal drag resolves cleanly.
    if (Math.abs(dx) > Math.abs(dy)) {
      this.push(dx > 0 ? ACTION.RIGHT : ACTION.LEFT);
    } else {
      this.push(dy > 0 ? ACTION.DUCK : ACTION.JUMP);
      if (dy > 0) this.held.duck = true;
    }
    state.fired = true;
  }

  _onTouchEnd(event) {
    event.preventDefault();
    const state = this._touch;
    this.held.duck = false;
    if (!state) return;

    const touch = Array.from(event.changedTouches)
      .find((t) => t.identifier === state.id);

    // A short, stationary touch is a tap -> jump. This gives mobile players a
    // fast way to hop without a full swipe gesture.
    if (touch && !state.fired) {
      const dt = performance.now() - state.t0;
      const moved = Math.hypot(touch.clientX - state.x0, touch.clientY - state.y0);
      if (dt < TAP_MAX_MS && moved < SWIPE_THRESHOLD) this.push(ACTION.JUMP);
    }
    this._touch = null;
  }

  // -------------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------------

  /**
   * Poll connected gamepads. Called once per frame from the game loop, because
   * the Gamepad API has no events for button state.
   */
  pollGamepad() {
    if (!navigator.getGamepads) return;
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }

    for (const pad of pads) {
      if (!pad) continue;
      const prev = this._gamepadPrev[pad.index] || {};
      const now = {};

      // D-pad (12-15) plus face buttons A (0) / B (1).
      const checks = [
        [14, ACTION.LEFT], [15, ACTION.RIGHT],
        [12, ACTION.JUMP], [13, ACTION.DUCK],
        [0, ACTION.JUMP], [1, ACTION.DUCK],
      ];
      for (const [index, action] of checks) {
        const pressed = !!(pad.buttons[index] && pad.buttons[index].pressed);
        now[index] = pressed;
        if (pressed && !prev[index]) this.push(action);   // rising edge only
      }

      // Left stick, with a dead zone so drift does not spam lane changes.
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const DEAD = 0.55;
      const stick = { l: ax < -DEAD, r: ax > DEAD, u: ay < -DEAD, d: ay > DEAD };
      if (stick.l && !prev.l) this.push(ACTION.LEFT);
      if (stick.r && !prev.r) this.push(ACTION.RIGHT);
      if (stick.u && !prev.u) this.push(ACTION.JUMP);
      if (stick.d && !prev.d) this.push(ACTION.DUCK);
      Object.assign(now, stick);

      // Start button pauses.
      const start = !!(pad.buttons[9] && pad.buttons[9].pressed);
      now.start = start;
      if (start && !prev.start && this.onPause) this.onPause();

      this._gamepadPrev[pad.index] = now;
    }
  }
}

/** Shared singleton. */
export const input = new InputManager();
