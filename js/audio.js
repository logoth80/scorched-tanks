/* =====================================================================
 * AUDIO — tiny synthesized SFX, created lazily on first user gesture.
 * Safe to call before init; everything no-ops until then.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});

const Sfx = {
  ctx: null, muted: false,
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noiseBuf = buf;
    } catch (e) { this.ctx = null; }
  },
  _noise(dur, freq, gain, type) {
    if (!this.ctx || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type || 'lowpass'; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); src.stop(this.ctx.currentTime + dur);
  },
  _tone(freq, dur, gain, type) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    o.type = type || 'square'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(this.ctx.currentTime + dur);
  },
  shot() { this._noise(0.15, 900, 0.5, 'bandpass'); },
  explosion(r) {
    const big = Math.min(1, r / 80);
    this._noise(0.35 + big * 0.35, 220 + big * 100, 0.6 + big * 0.4);
    this._tone(60 - big * 25, 0.3, 0.35, 'sine');
  },
  click() { this._tone(1200, 0.04, 0.08, 'square'); },
  buy() { this._tone(880, 0.07, 0.1); this._tone(1320, 0.07, 0.08); },
  chime() { this._tone(660, 0.12, 0.1, 'triangle'); this._tone(990, 0.18, 0.08, 'triangle'); },
  chute() { this._noise(0.25, 2400, 0.25, 'highpass'); },
  hit() { this._tone(220, 0.1, 0.2, 'sawtooth'); },
  death() { this._tone(320, 0.4, 0.25, 'sawtooth'); this._noise(0.4, 400, 0.4); },
};

SE.sfx = Sfx;
})(typeof window !== 'undefined' ? window : globalThis);
