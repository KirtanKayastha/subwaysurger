/**
 * Procedural audio.
 *
 * Every sound is synthesised at runtime with the Web Audio API - there are no
 * audio files anywhere in this project. That keeps the game fully offline and
 * instant to load, and lets sounds react to game state (e.g. the coin pitch
 * climbs with your combo).
 *
 * Browser autoplay policy: an AudioContext starts "suspended" until a user
 * gesture. `unlock()` is wired to the first pointer/key event; until then every
 * call is a cheap no-op.
 */

import { clamp, clamp01 } from './util.js';

/** Semitone ratio helper: midi-ish note number -> frequency in Hz. */
const noteHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** Pentatonic scale degrees used by the coin arpeggio (sounds good in any order). */
const PENTATONIC = [0, 2, 4, 7, 9];

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;

    this.enabled = true;      // master mute toggle
    this.musicEnabled = true;
    this.volume = 0.75;

    this.unlocked = false;
    this._musicTimer = 0;
    this._musicStep = 0;
    this._noiseBuffer = null;
    /** Guards against stacking dozens of identical sounds in one frame. */
    this._lastPlay = new Map();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create/resume the AudioContext. Safe to call repeatedly; must be called
   * from within a user-gesture handler the first time.
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;               // ancient browser: run silently
      try {
        this.ctx = new Ctor();
      } catch {
        return false;
      }

      // master -> destination, with sfx and music sub-buses for independent
      // volume control and ducking.
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1;
      this.sfxGain.connect(this.master);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.34;
      this.musicGain.connect(this.master);

      this._buildNoise();
    }

    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.unlocked = this.ctx.state === 'running';
    return this.unlocked;
  }

  /** Pre-render one second of white noise for percussive/impact sounds. */
  _buildNoise() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master && this.ctx) {
      // Ramp rather than snap, to avoid a click.
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, t, 0.02);
    }
  }

  setMusicEnabled(on) {
    this.musicEnabled = !!on;
    if (this.musicGain && this.ctx) {
      const t = this.ctx.currentTime;
      this.musicGain.gain.setTargetAtTime(this.musicEnabled ? 0.34 : 0, t, 0.05);
    }
  }

  setVolume(v) {
    this.volume = clamp01(v);
    if (this.enabled) this.setEnabled(true);
  }

  /** True when it is worth synthesising anything at all. */
  get ready() {
    return !!(this.ctx && this.enabled && this.ctx.state === 'running');
  }

  /** Rate-limit a given sound id to at most one per `ms`. */
  _throttle(id, ms) {
    const now = performance.now();
    const last = this._lastPlay.get(id) || 0;
    if (now - last < ms) return false;
    this._lastPlay.set(id, now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Synth primitives
  // -------------------------------------------------------------------------

  /**
   * A single oscillator voice with an ADSR-ish envelope.
   *
   * @param {object} o
   * @param {number} o.freq      start frequency (Hz)
   * @param {number} [o.freqEnd] optional glide target
   * @param {string} [o.type]    oscillator waveform
   * @param {number} [o.gain]    peak gain
   * @param {number} [o.attack]  seconds
   * @param {number} [o.decay]   seconds (to zero)
   * @param {number} [o.delay]   scheduling offset
   */
  tone({
    freq, freqEnd = null, type = 'sine', gain = 0.3,
    attack = 0.005, decay = 0.2, delay = 0, detune = 0,
    filter = null,
  }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      // Exponential ramps cannot reach 0 and sound more natural for pitch.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + decay);
    }
    if (detune) osc.detune.setValueAtTime(detune, t0);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    let node = osc;
    if (filter) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = filter.type || 'lowpass';
      biquad.frequency.setValueAtTime(filter.freq || 1200, t0);
      if (filter.freqEnd) {
        biquad.frequency.exponentialRampToValueAtTime(
          Math.max(1, filter.freqEnd), t0 + attack + decay);
      }
      biquad.Q.value = filter.q ?? 1;
      node.connect(biquad);
      node = biquad;
    }

    node.connect(env);
    env.connect(this.sfxGain);

    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.02);
  }

  /** Filtered noise burst - impacts, whooshes, landings. */
  noise({
    gain = 0.3, attack = 0.004, decay = 0.18, delay = 0,
    type = 'bandpass', freq = 1000, freqEnd = null, q = 1,
  }) {
    if (!this.ready || !this._noiseBuffer) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;

    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;

    const biquad = ctx.createBiquadFilter();
    biquad.type = type;
    biquad.frequency.setValueAtTime(freq, t0);
    if (freqEnd) {
      biquad.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + decay);
    }
    biquad.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    src.connect(biquad);
    biquad.connect(env);
    env.connect(this.sfxGain);

    src.start(t0);
    src.stop(t0 + attack + decay + 0.02);
  }

  // -------------------------------------------------------------------------
  // Game sound effects
  // -------------------------------------------------------------------------

  /** Coin pickup. Pitch rises with the combo for escalating satisfaction. */
  coin(combo = 0) {
    if (!this.ready) return;
    const step = PENTATONIC[Math.min(combo, PENTATONIC.length * 3 - 1) % PENTATONIC.length];
    const octave = Math.min(2, Math.floor(combo / PENTATONIC.length));
    const base = 81 + step + octave * 12;   // ~A5 upward
    this.tone({ freq: noteHz(base), type: 'triangle', gain: 0.16, attack: 0.002, decay: 0.1 });
    this.tone({ freq: noteHz(base + 12), type: 'sine', gain: 0.08, attack: 0.002, decay: 0.07, delay: 0.02 });
  }

  /** Jump: short upward blip plus an air whoosh. */
  jump() {
    this.tone({ freq: 320, freqEnd: 620, type: 'square', gain: 0.09, attack: 0.004, decay: 0.13,
                filter: { type: 'lowpass', freq: 2400 } });
    this.noise({ gain: 0.05, decay: 0.16, freq: 700, freqEnd: 2000, type: 'bandpass', q: 0.8 });
  }

  /** Landing thud, scaled by impact strength (0..1). */
  land(strength = 1) {
    if (!this._throttle('land', 60)) return;
    const g = 0.06 + 0.09 * clamp01(strength);
    this.tone({ freq: 150, freqEnd: 60, type: 'sine', gain: g, attack: 0.002, decay: 0.12 });
    this.noise({ gain: g * 0.5, decay: 0.09, freq: 420, freqEnd: 140, type: 'lowpass' });
  }

  /** Lane change: a quick filtered swish. */
  swipe() {
    if (!this._throttle('swipe', 50)) return;
    this.noise({ gain: 0.05, attack: 0.005, decay: 0.1, freq: 1400, freqEnd: 500,
                 type: 'bandpass', q: 1.6 });
  }

  /** Slide/duck: low friction noise. */
  slide() {
    this.noise({ gain: 0.07, attack: 0.01, decay: 0.3, freq: 320, freqEnd: 900,
                 type: 'bandpass', q: 0.7 });
  }

  /** Power-up collected: bright rising arpeggio. */
  powerup() {
    const root = 69;
    [0, 4, 7, 12].forEach((semi, i) => {
      this.tone({
        freq: noteHz(root + semi), type: 'triangle', gain: 0.13,
        attack: 0.003, decay: 0.22, delay: i * 0.045,
      });
    });
  }

  /** Near miss: a tense little whoosh + tick. */
  nearMiss() {
    if (!this._throttle('near', 140)) return;
    this.noise({ gain: 0.07, attack: 0.002, decay: 0.14, freq: 2600, freqEnd: 700,
                 type: 'bandpass', q: 2.2 });
    this.tone({ freq: 1500, freqEnd: 900, type: 'sine', gain: 0.05, decay: 0.09 });
  }

  /** Shield absorbing a hit. */
  shieldBreak() {
    this.tone({ freq: 900, freqEnd: 180, type: 'sawtooth', gain: 0.15, decay: 0.35,
                filter: { type: 'lowpass', freq: 3000, freqEnd: 500 } });
    this.noise({ gain: 0.12, decay: 0.3, freq: 1800, freqEnd: 300, type: 'bandpass' });
  }

  /** Fatal crash: layered noise burst + descending tone. */
  crash() {
    this.noise({ gain: 0.3, attack: 0.001, decay: 0.55, freq: 1200, freqEnd: 90, type: 'lowpass' });
    this.tone({ freq: 220, freqEnd: 42, type: 'sawtooth', gain: 0.22, attack: 0.002, decay: 0.6,
                filter: { type: 'lowpass', freq: 1600, freqEnd: 200 } });
    this.tone({ freq: 110, freqEnd: 30, type: 'square', gain: 0.14, decay: 0.5, delay: 0.03 });
  }

  /** Hoverboard save: heroic swell. */
  revive() {
    [0, 5, 9, 12, 16].forEach((semi, i) => {
      this.tone({ freq: noteHz(57 + semi), type: 'sawtooth', gain: 0.1, attack: 0.02,
                  decay: 0.4, delay: i * 0.06,
                  filter: { type: 'lowpass', freq: 900, freqEnd: 3200 } });
    });
  }

  /** UI click. */
  click() {
    this.tone({ freq: 660, type: 'square', gain: 0.05, attack: 0.001, decay: 0.05,
                filter: { type: 'lowpass', freq: 2600 } });
  }

  /** Purchase confirmed. */
  purchase() {
    this.tone({ freq: noteHz(72), type: 'triangle', gain: 0.12, decay: 0.16 });
    this.tone({ freq: noteHz(79), type: 'triangle', gain: 0.11, decay: 0.22, delay: 0.09 });
  }

  /** Rejected action (not enough coins). */
  deny() {
    this.tone({ freq: 180, freqEnd: 120, type: 'square', gain: 0.09, decay: 0.18,
                filter: { type: 'lowpass', freq: 900 } });
  }

  /** Countdown tick; `final` uses a higher, brighter tone. */
  countdown(final = false) {
    this.tone({
      freq: final ? noteHz(81) : noteHz(69),
      type: 'triangle', gain: 0.16, attack: 0.003, decay: final ? 0.4 : 0.16,
    });
  }

  /** Milestone / new record fanfare. */
  fanfare() {
    [0, 4, 7, 12, 19].forEach((semi, i) => {
      this.tone({ freq: noteHz(69 + semi), type: 'triangle', gain: 0.13,
                  attack: 0.005, decay: 0.45, delay: i * 0.1 });
    });
  }

  /** Combo tier increase - pitch climbs with the tier. */
  comboUp(tier = 1) {
    this.tone({
      freq: noteHz(72 + Math.min(tier, 8) * 2), type: 'square', gain: 0.09,
      attack: 0.002, decay: 0.14, filter: { type: 'lowpass', freq: 3000 },
    });
  }

  // -------------------------------------------------------------------------
  // Adaptive music bed
  // -------------------------------------------------------------------------

  /**
   * Advance the sequencer. Called every frame with the current game intensity
   * (0..1, derived from speed) so the bassline tightens as you go faster.
   */
  updateMusic(dt, intensity = 0, playing = false) {
    if (!this.ready || !this.musicEnabled || !playing) return;

    // Tempo rises from 120 to ~168 BPM across the intensity range.
    const bpm = 120 + intensity * 48;
    const stepDur = 60 / bpm / 2;           // eighth notes

    this._musicTimer -= dt;
    if (this._musicTimer > 0) return;
    this._musicTimer = stepDur;

    const step = this._musicStep++ % 16;
    // Minor pentatonic bass pattern; sparse so it never fights the SFX.
    const pattern = [0, null, 7, null, 3, null, 7, 10, 0, null, 5, null, 3, null, 10, 7];
    const semi = pattern[step];

    if (semi !== null) {
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      const t0 = this.ctx.currentTime;

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(noteHz(33 + semi), t0);

      lp.type = 'lowpass';
      // Filter opens up with intensity - classic "energy" cue.
      lp.frequency.setValueAtTime(320 + intensity * 1500, t0);
      lp.Q.value = 6;

      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(0.16, t0 + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + stepDur * 0.9);

      osc.connect(lp); lp.connect(env); env.connect(this.musicGain);
      osc.start(t0);
      osc.stop(t0 + stepDur);
    }

    // Hi-hat on off-beats, kick on the downbeat.
    if (step % 2 === 1) {
      this._hat(0.03 + intensity * 0.02);
    }
    if (step % 8 === 0) {
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t0);
      osc.frequency.exponentialRampToValueAtTime(42, t0 + 0.11);
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(0.22, t0 + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      osc.connect(env); env.connect(this.musicGain);
      osc.start(t0); osc.stop(t0 + 0.18);
    }
  }

  _hat(gain) {
    if (!this._noiseBuffer) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const hp = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();
    src.buffer = this._noiseBuffer;
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    src.connect(hp); hp.connect(env); env.connect(this.musicGain);
    src.start(t0); src.stop(t0 + 0.06);
  }

  /** Reset the sequencer between runs so music restarts on the downbeat. */
  resetMusic() {
    this._musicStep = 0;
    this._musicTimer = 0;
  }
}

/** Shared singleton - the game only ever needs one audio graph. */
export const audio = new AudioEngine();
