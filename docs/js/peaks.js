/* Audabook — waveform summaries, so drawing a long song stays fast on a slow Chromebook. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});
  const BIN = (SS.PEAK_BIN = 256); // samples summarised by one min/max pair

  /** Min/max of every BIN samples across all channels. */
  SS.computePeaks = function (channels, length) {
    const n = Math.ceil(length / BIN);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let b = 0; b < n; b++) {
        const s0 = b * BIN;
        const s1 = Math.min(s0 + BIN, length);
        let lo = d[s0];
        let hi = lo;
        for (let i = s0 + 1; i < s1; i++) {
          const v = d[i];
          if (v < lo) lo = v;
          else if (v > hi) hi = v;
        }
        if (c === 0 || lo < min[b]) min[b] = lo;
        if (c === 0 || hi > max[b]) max[b] = hi;
      }
    }
    return { min, max, count: n };
  };

  /** Peaks that grow while recording. `count` includes the partly-filled last bin. */
  class PeakBuilder {
    constructor() {
      this.min = new Float32Array(4096);
      this.max = new Float32Array(4096);
      this.full = 0;
      this.partial = 0;
      this.length = 0;
    }
    get count() {
      return this.full + (this.partial ? 1 : 0);
    }
    append(channels) {
      const len = channels[0].length;
      for (let i = 0; i < len; i++) {
        let lo = channels[0][i];
        let hi = lo;
        for (let c = 1; c < channels.length; c++) {
          const v = channels[c][i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (this.full >= this.min.length) this.grow();
        const b = this.full;
        if (this.partial === 0) {
          this.min[b] = lo;
          this.max[b] = hi;
        } else {
          if (lo < this.min[b]) this.min[b] = lo;
          if (hi > this.max[b]) this.max[b] = hi;
        }
        if (++this.partial === BIN) {
          this.full++;
          this.partial = 0;
        }
      }
      this.length += len;
    }
    grow() {
      const min = new Float32Array(this.min.length * 2);
      const max = new Float32Array(this.max.length * 2);
      min.set(this.min);
      max.set(this.max);
      this.min = min;
      this.max = max;
    }
  }
  SS.PeakBuilder = PeakBuilder;

  /**
   * Lowest and highest sample between positions s0 and s1 of a source.
   * src: { channels (Float32Array[] or null), length, peaks }. Writes into out = [lo, hi]; false if empty.
   */
  SS.sampleRange = function (src, s0, s1, out) {
    if (s1 - s0 >= BIN * 2 || !src.channels) {
      const pk = src.peaks;
      const b0 = Math.max(0, Math.floor(s0 / BIN));
      const b1 = Math.min(pk.count, Math.ceil(s1 / BIN));
      if (b1 <= b0) return false;
      let lo = pk.min[b0];
      let hi = pk.max[b0];
      for (let b = b0 + 1; b < b1; b++) {
        if (pk.min[b] < lo) lo = pk.min[b];
        if (pk.max[b] > hi) hi = pk.max[b];
      }
      out[0] = lo;
      out[1] = hi;
      return true;
    }
    const i0 = Math.max(0, Math.floor(s0));
    const i1 = Math.min(src.length, Math.ceil(s1));
    if (i1 <= i0) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < src.channels.length; c++) {
      const d = src.channels[c];
      for (let i = i0; i < i1; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out[0] = lo;
    out[1] = hi;
    return true;
  };

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
