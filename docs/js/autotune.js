/* Audabook — Auto-Tune engine.

   A JavaScript port of the pitch-correction engine of x42-Autotune (fat1.lv2, Robin Gareus), which is
   Fons Adriaensen's zita-at1 "Retuner", plus his zita-resampler used for 2x upsampling.
     retuner.cc   Copyright (C) 2009-2011 Fons Adriaensen <fons@linuxaudio.org>   GPL-2.0-or-later
     resampler.cc Copyright (C) 2006-2012 Fons Adriaensen <fons@linuxaudio.org>   GPL-3.0-or-later
     fat1.cc      Copyright (C) 2016 Robin Gareus <robin@gareus.org>              GPL-2.0-or-later
   This file is therefore distributed under the GNU General Public License, version 3 or later.
   The FFT (FFTW in the original) is a plain radix-2 FFT written for this port.

   How it works: the input is upsampled 2x into a ring buffer. Every 4 fragments of 128 samples the pitch
   period is found by autocorrelation (via FFT), the nearest allowed note is chosen, and the read speed is
   set so the pitch lands on that note. When the read position drifts too far, it jumps by a whole number
   of pitch periods with a short crossfade, so the voice keeps its timing without warbling.

   Everything lives inside one function so the same code can be stringified into an AudioWorklet. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});

  function autotuneDSP() {
    // ---- FFT: radix-2, in place, unnormalised in both directions (same scaling as FFTW) ----------
    class FFT {
      constructor(n) {
        this.n = n;
        this.cos = new Float64Array(n / 2);
        this.sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
          this.cos[i] = Math.cos((2 * Math.PI * i) / n);
          this.sin[i] = Math.sin((2 * Math.PI * i) / n);
        }
        this.rev = new Uint32Array(n);
        const bits = Math.round(Math.log2(n));
        for (let i = 0; i < n; i++) {
          let r = 0;
          for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
          this.rev[i] = r;
        }
      }

      transform(re, im, inverse) {
        const n = this.n;
        const rev = this.rev;
        for (let i = 0; i < n; i++) {
          const j = rev[i];
          if (j > i) {
            let t = re[i];
            re[i] = re[j];
            re[j] = t;
            t = im[i];
            im[i] = im[j];
            im[j] = t;
          }
        }
        const sgn = inverse ? 1 : -1;
        for (let size = 2; size <= n; size <<= 1) {
          const half = size >> 1;
          const step = n / size;
          for (let i = 0; i < n; i += size) {
            for (let j = i, k = 0; j < i + half; j++, k += step) {
              const l = j + half;
              const c = this.cos[k];
              const s = sgn * this.sin[k];
              const tr = re[l] * c - im[l] * s;
              const ti = re[l] * s + im[l] * c;
              re[l] = re[j] - tr;
              im[l] = im[j] - ti;
              re[j] += tr;
              im[j] += ti;
            }
          }
        }
      }
    }

    // ---- zita-resampler (single channel) ---------------------------------------------------
    function gcd(a, b) {
      if (a === 0) return b;
      if (b === 0) return a;
      for (;;) {
        if (a > b) {
          a = a % b;
          if (a === 0) return b;
          if (a === 1) return 1;
        } else {
          b = b % a;
          if (b === 0) return a;
          if (b === 1) return 1;
        }
      }
    }

    function sinc(x) {
      x = Math.abs(x);
      if (x < 1e-6) return 1.0;
      x *= Math.PI;
      return Math.sin(x) / x;
    }

    function wind(x) {
      x = Math.abs(x);
      if (x >= 1.0) return 0.0;
      x *= Math.PI;
      return 0.384 + 0.5 * Math.cos(x) + 0.116 * Math.cos(2 * x);
    }

    class Resampler {
      constructor(fsInp, fsOut, hlen) {
        let frel = 1.0 - 2.6 / hlen;
        const r = fsOut / fsInp;
        const g = gcd(fsOut, fsInp);
        const n = fsOut / g;
        const s = fsInp / g;
        let h = hlen;
        let k = 250;
        if (r < 1) {
          frel *= r;
          h = Math.ceil(h / r);
          k = Math.ceil(k / r);
        }
        // Filter table: np + 1 phases of hl taps (Resampler_table).
        this.hl = h;
        this.np = n;
        this.ctab = new Float32Array(h * (n + 1));
        for (let j = 0; j <= n; j++) {
          let t = j / n;
          const p = j * h;
          for (let i = 0; i < h; i++) {
            this.ctab[p + h - i - 1] = frel * sinc(t * frel) * wind(t / h);
            t += 1;
          }
        }
        this.buff = new Float32Array(2 * h - 1 + k);
        this.inmax = k;
        this.pstep = s;
        this.index = 0;
        this.nread = 2 * h;
        this.nzero = 0;
        this.phase = 0;
      }

      /** Consumes up to inpCount samples from inp[inpPos..] (null = zeros) and writes up to outCount to out[outPos..]. */
      process(inp, inpPos, inpCount, out, outPos, outCount) {
        const hl = this.hl;
        const np = this.np;
        const dp = this.pstep;
        const buff = this.buff;
        const ctab = this.ctab;
        let inIdx = this.index;
        let nr = this.nread;
        let ph = this.phase;
        let nz = this.nzero;
        let p1 = inIdx;
        let p2 = p1 + (2 * hl - nr);
        while (outCount) {
          if (nr) {
            if (inpCount === 0) break;
            if (inp) {
              buff[p2] = inp[inpPos++];
              nz = 0;
            } else {
              buff[p2] = 0;
              if (nz < 2 * hl) nz++;
            }
            nr--;
            p2++;
            inpCount--;
          } else {
            if (out) {
              if (nz < 2 * hl) {
                const c1 = hl * ph;
                const c2 = hl * (np - ph);
                let q1 = p1;
                let q2 = p2;
                let s = 1e-20;
                for (let i = 0; i < hl; i++) {
                  q2--;
                  s += buff[q1] * ctab[c1 + i] + buff[q2] * ctab[c2 + i];
                  q1++;
                }
                out[outPos++] = s - 1e-20;
              } else {
                out[outPos++] = 0;
              }
            }
            outCount--;
            ph += dp;
            if (ph >= np) {
              nr = Math.floor(ph / np);
              ph -= nr * np;
              inIdx += nr;
              p1 += nr;
              if (inIdx >= this.inmax) {
                const m = 2 * hl - nr;
                buff.copyWithin(0, p1, p1 + m);
                inIdx = 0;
                p1 = 0;
                p2 = m;
              }
            }
          }
        }
        this.index = inIdx;
        this.nread = nr;
        this.phase = ph;
        this.nzero = nz;
      }
    }

    // ---- zita-at1 Retuner ------------------------------------------------------------------
    function cubic(v, i, a) {
      const b = 1 - a;
      const c = a * b;
      return (1.0 + 1.5 * c) * (v[i + 1] * b + v[i + 2] * a) - 0.5 * c * (v[i] * b + v[i + 1] + v[i + 2] + v[i + 3] * a);
    }

    class Retuner {
      constructor(fsamp) {
        this.fsamp = fsamp;
        this.refpitch = 440;
        this.notebias = 0;
        this.corrfilt = 1;
        this.corrgain = 1;
        this.corroffs = 0;
        this.notemask = 0xfff;
        this.fastmode = false;
        this.readahead = 0;
        this.lastreadahead = 0;
        this.voiced = false;
        if (fsamp < 64000) {
          // At 44.1 and 48 kHz resample to double rate.
          this.upsamp = true;
          this.ipsize = 4096;
          this.fftlen = 2048;
          this.frsize = 128;
          this.resampler = new Resampler(1, 2, 32); // 32 is medium quality
          this.resampler.process(null, 0, this.resampler.hl * 2 - 1, null, 0, 0); // prefeed (as in the original)
        } else if (fsamp < 128000) {
          this.upsamp = false;
          this.ipsize = 4096;
          this.fftlen = 4096;
          this.frsize = 256;
        } else {
          this.upsamp = false;
          this.ipsize = 8192;
          this.fftlen = 8192;
          this.frsize = 512;
        }
        // Accepted correlation peak range, corresponding to 60..1200 Hz.
        this.ifmin = Math.floor(fsamp / 1200);
        this.ifmax = Math.floor(fsamp / 60);

        this.ipbuff = new Float32Array(this.ipsize + 3);
        this.xffunc = new Float32Array(this.frsize);
        this.fftTwind = new Float32Array(this.fftlen);
        this.fftWcorr = new Float32Array(this.fftlen);
        this.fftTdata = new Float32Array(this.fftlen);
        this.re = new Float64Array(this.fftlen);
        this.im = new Float64Array(this.fftlen);
        this.fft = new FFT(this.fftlen);

        // Crossfade function, half of raised cosine.
        for (let i = 0; i < this.frsize; i++) this.xffunc[i] = 0.5 * (1 - Math.cos((Math.PI * i) / this.frsize));
        // Window, raised cosine.
        for (let i = 0; i < this.fftlen; i++) this.fftTwind[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.fftlen));
        // Autocorrelation of the window, normalised.
        this.autocorr(this.fftTwind, this.fftWcorr, false);
        const t = this.fftWcorr[0];
        for (let i = 0; i < this.fftlen; i++) this.fftWcorr[i] /= t;

        this.notebits = 0;
        this.lastnote = -1;
        this.count = 0;
        this.cycle = this.frsize;
        this.error = 0;
        this.ratio = 1;
        this.xfade = false;
        this.ipindex = 0;
        this.frindex = 0;
        this.frcount = 0;
        this.rindex1 = this.ipsize / 2;
        this.rindex2 = 0;
        this.notescale = new Float32Array(12);
        for (let i = 0; i < 12; i++) this.notescale[i] = i;
      }

      set_refpitch(v) { this.refpitch = v; }
      set_notebias(v) { this.notebias = v / 13.0; }
      set_corrfilt(v) { this.corrfilt = (4 * this.frsize) / (v * this.fsamp); }
      set_corrgain(v) { this.corrgain = v; }
      set_corroffs(v) { this.corroffs = v; }
      set_notemask(k) { this.notemask = k; }
      set_fastmode(v) { this.fastmode = !!v; }
      get_error() { return 12 * this.error; }

      /** Samples of delay between input and output (as fat1 reports it). */
      latency() {
        const base = this.fsamp < 64000 ? 1024 : this.fsamp < 128000 ? 2048 : 4096;
        return (this.fastmode ? base / 8 : base) + (this.upsamp ? 32 : 0);
      }

      // r2c FFT, |X|^2 with optional spectral tilt, c2r FFT: the (unnormalised) autocorrelation.
      autocorr(src, dst, tilt) {
        const n = this.fftlen;
        const h = n / 2;
        const re = this.re;
        const im = this.im;
        for (let i = 0; i < n; i++) {
          re[i] = src[i];
          im[i] = 0;
        }
        this.fft.transform(re, im, false);
        const f = this.fsamp / (n * 3e3);
        for (let i = 0; i < h; i++) {
          const x = re[i];
          const y = im[i];
          const m = i * f;
          re[i] = tilt ? (x * x + y * y) / (1 + m * m) : x * x + y * y;
          im[i] = 0;
        }
        re[h] = 0;
        im[h] = 0;
        for (let i = 1; i < h; i++) {
          re[n - i] = re[i];
          im[n - i] = 0;
        }
        this.fft.transform(re, im, true);
        for (let i = 0; i < n; i++) dst[i] = re[i];
      }

      process(nfram, inp, inpPos, out, outPos) {
        const ipbuff = this.ipbuff;
        const ipsize = this.ipsize;
        const frsize = this.frsize;
        let fi = this.frindex;
        let r1 = this.rindex1;
        let r2 = this.rindex2;
        let i;
        let ii;
        let u1;
        let u2;
        let v;

        while (nfram) {
          let k = frsize - fi;
          if (nfram < k) k = nfram;
          nfram -= k;

          if (this.upsamp) {
            this.resampler.process(inp, inpPos, k, ipbuff, this.ipindex, 2 * k);
            this.ipindex += 2 * k;
          } else {
            for (let j = 0; j < k; j++) ipbuff[this.ipindex + j] = inp[inpPos + j];
            this.ipindex += k;
          }
          // Extra samples for interpolation.
          ipbuff[ipsize] = ipbuff[0];
          ipbuff[ipsize + 1] = ipbuff[1];
          ipbuff[ipsize + 2] = ipbuff[2];
          inpPos += k;
          if (this.ipindex === ipsize) this.ipindex = 0;

          let dr = this.ratio;
          if (this.upsamp) dr *= 2;
          if (this.xfade) {
            while (k--) {
              i = r1 | 0;
              ii = i + this.lastreadahead;
              if (ii >= ipsize) ii -= ipsize;
              u1 = cubic(ipbuff, ii, r1 - i);
              i = r2 | 0;
              ii = i + this.readahead;
              if (ii >= ipsize) ii -= ipsize;
              u2 = cubic(ipbuff, ii, r2 - i);
              v = this.xffunc[fi++];
              out[outPos++] = (1 - v) * u1 + v * u2;
              r1 += dr;
              if (r1 >= ipsize) r1 -= ipsize;
              r2 += dr;
              if (r2 >= ipsize) r2 -= ipsize;
            }
          } else if (this.readahead === 0 && this.lastreadahead === 0) {
            fi += k;
            while (k--) {
              i = r1 | 0;
              out[outPos++] = cubic(ipbuff, i, r1 - i);
              r1 += dr;
              if (r1 >= ipsize) r1 -= ipsize;
            }
          } else if (this.readahead !== this.lastreadahead) {
            // Crossfade from/to fast mode.
            while (k--) {
              i = r1 | 0;
              ii = i + this.lastreadahead;
              if (ii >= ipsize) ii -= ipsize;
              u1 = cubic(ipbuff, ii, r1 - i);
              ii = i + this.readahead;
              if (ii >= ipsize) ii -= ipsize;
              u2 = cubic(ipbuff, ii, r1 - i);
              v = this.xffunc[fi++];
              out[outPos++] = (1 - v) * u1 + v * u2;
              r1 += dr;
              if (r1 >= ipsize) r1 -= ipsize;
            }
          } else {
            // Interpolation only (fast mode).
            fi += k;
            while (k--) {
              i = r1 | 0;
              ii = i + this.readahead;
              if (ii >= ipsize) ii -= ipsize;
              out[outPos++] = cubic(ipbuff, ii, r1 - i);
              r1 += dr;
              if (r1 >= ipsize) r1 -= ipsize;
            }
          }

          // At the end of a fragment, check for a jump.
          if (fi === frsize) {
            fi = 0;
            // Estimate the pitch every 4th fragment.
            if (++this.frcount === 4) {
              this.frcount = 0;
              const cycle = this.findcycle();
              if (cycle > 0) {
                this.cycle = cycle;
                this.voiced = true;
                this.count = 0;
                this.finderror();
              } else if (++this.count > 5) {
                // Unvoiced for a while: reset the pitch error.
                this.count = 5;
                this.cycle = frsize;
                this.voiced = false;
                this.error = 0;
              } else if (this.count === 2) {
                // Bias is removed after two unvoiced fragments.
                this.lastnote = -1;
              }
              this.ratio = Math.pow(2.0, this.corroffs / 12.0 - this.error * this.corrgain);
            }
            // If the previous fragment was crossfading, its faded-in end is the new read position.
            if (this.xfade) r1 = r2;
            // A jump must be a whole number of pitch periods, and at least one fragment long.
            dr = this.cycle * Math.ceil(frsize / this.cycle);
            const dp = dr / frsize;
            let ph = r1 - this.ipindex;
            if (ph < 0) ph += ipsize;
            if (this.upsamp) {
              ph /= 2;
              dr *= 2;
            }
            ph = ph / frsize + 2 * this.ratio - 10;
            if (!this.voiced) {
              // Unvoiced: reset the read position (consistent latency, no jitter).
              this.xfade = true;
              r2 = this.ipindex - ipsize / 2;
            } else if (ph > 0.5) {
              this.xfade = true;
              r2 = r1 - dr; // jump back
            } else if (ph + dp < 0.5) {
              this.xfade = true;
              r2 = r1 + dr; // jump forward
            } else {
              this.xfade = false;
            }
            if (r2 < 0) r2 += ipsize;
            // Fast mode outputs before the pitch is known: lower latency, slightly later correction.
            this.lastreadahead = this.readahead;
            this.readahead = this.fastmode ? (ipsize * 7) / 16 : 0;
          }
        }
        this.frindex = fi;
        this.rindex1 = r1;
        this.rindex2 = r2;
      }

      findcycle() {
        const d = this.upsamp ? 2 : 1;
        const n = this.fftlen;
        const h = n / 2;
        const k = this.ipsize - 1;
        const T = this.fftTdata;
        let j = this.ipindex;
        let rms = 0;
        for (let i = 0; i < n; i++) {
          const v = this.ipbuff[j & k];
          T[i] = this.fftTwind[i] * v;
          rms += v * v;
          j += d;
        }
        // Ignore the noise floor (fat1's MOD build): below -45 dBFS RMS counts as unvoiced.
        if (rms < n * 0.000031623) return 0;
        this.autocorr(T, T, true);
        const t = T[0] + 0.1;
        for (let i = 0; i < h; i++) T[i] /= t * this.fftWcorr[i];
        let x = T[0];
        let y;
        let z;
        let i;
        for (i = 4; i < this.ifmax; i += 4) {
          y = T[i];
          if (y > x) break;
          x = y;
        }
        i -= 4;
        if (i >= this.ifmax) return 0;
        if (i < this.ifmin) i = this.ifmin;
        x = T[--i];
        y = T[++i];
        let m = 0;
        let jj = 0;
        while (i <= this.ifmax) {
          const tt = y * this.fftWcorr[i];
          z = T[++i];
          if (tt > m && y >= x && y >= z && y > 0.8) {
            jj = i - 1;
            m = tt;
          }
          x = y;
          y = z;
        }
        if (jj) {
          x = T[jj - 1];
          y = T[jj];
          z = T[jj + 1];
          if (Math.abs(z - 2 * y + x) > 2e-9) return jj + (0.5 * (x - z)) / (z - 2 * y + x - 1e-9);
        }
        return 0;
      }

      finderror() {
        if (!this.notemask) {
          this.error = 0;
          this.lastnote = -1;
          return;
        }
        const f = Math.log2(this.fsamp / (this.cycle * this.refpitch));
        let dm = 0;
        let am = 1;
        let im = -1;
        for (let i = 0, m = 1; i < 12; i++, m <<= 1) {
          if (this.notemask & m) {
            let d = f - (this.notescale[i] - 9) / 12.0;
            d -= Math.floor(d + 0.5);
            let a = Math.abs(d);
            if (i === this.lastnote) a -= this.notebias;
            if (a < am) {
              am = a;
              dm = d;
              im = i;
            }
          }
        }
        if (this.lastnote === im) {
          this.error += this.corrfilt * (dm - this.error);
        } else {
          this.error = dm;
          this.lastnote = im;
        }
        this.notebits |= 1 << im;
      }
    }

    /** Notes allowed by a key: 'any' (all 12), or e.g. 'A minor' / 'F# major' (as fat1's set_scale). */
    function keyMask(key) {
      const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const m = /^([A-G]#?) (major|minor)$/.exec(key || '');
      if (!m) return 0xfff;
      let tonic = NAMES.indexOf(m[1]);
      if (m[2] === 'minor') tonic = (tonic + 3) % 12; // a minor key uses the notes of its relative major
      const western = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
      let mask = 0;
      for (let i = 0; i < 12; i++) if (western[(i - tonic + 12) % 12]) mask |= 1 << i;
      return mask;
    }

    /**
     * The friendly "Style" slider (0 = natural, 1 = robot) mapped onto fat1's controls:
     * retune smoothing ("Filter", 0.5 s .. 0.02 s, log scale) and correction strength.
     */
    function styleParams(style) {
      const s = Math.min(1, Math.max(0, +style || 0));
      return {
        filter: 0.5 * Math.pow(0.02 / 0.5, s),
        corr: s < 0.25 ? 0.7 + 1.2 * s : 1.0,
      };
    }

    return { FFT, Resampler, Retuner, keyMask, styleParams };
  }

  SS.autotuneDSP = autotuneDSP;
  SS.AutoTune = autotuneDSP();

  // The AudioWorklet that runs the engine on Chrome's audio thread.
  function autotuneProcessor() {
    class AutoTuneProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.rt = new DSP.Retuner(sampleRate);
        this.rt.set_refpitch(440);
        this.rt.set_notebias(0.5);
        this.mono = new Float32Array(128);
        this.out = new Float32Array(128);
        this.alive = true;
        this.apply(o);
        this.port.onmessage = (e) => this.apply(e.data || {});
      }
      apply(o) {
        if (o.key !== undefined) this.rt.set_notemask(DSP.keyMask(o.key));
        if (o.style !== undefined) {
          const p = DSP.styleParams(o.style);
          this.rt.set_corrfilt(p.filter);
          this.rt.set_corrgain(p.corr);
        }
        if (o.fast !== undefined) this.rt.set_fastmode(o.fast);
        if (o.close) this.alive = false; // playback stopped: let Chrome free this node
      }
      process(inputs, outputs) {
        if (!this.alive) return false;
        const inp = inputs[0];
        const out = outputs[0];
        const n = out[0].length;
        if (this.mono.length !== n) {
          this.mono = new Float32Array(n);
          this.out = new Float32Array(n);
        }
        // Vocals are tuned in mono: sum the channels, then send the same signal to every output channel.
        const mono = this.mono;
        mono.fill(0);
        if (inp && inp.length) {
          const g = 1 / inp.length;
          for (let c = 0; c < inp.length; c++) for (let i = 0; i < n; i++) mono[i] += inp[c][i] * g;
        }
        this.rt.process(n, mono, 0, this.out, 0);
        for (let c = 0; c < out.length; c++) out[c].set(this.out);
        return true;
      }
    }
    registerProcessor('ss-autotune', AutoTuneProcessor);
  }

  SS.AUTOTUNE_WORKLET = 'const DSP = (' + autotuneDSP.toString() + ')();\n(' + autotuneProcessor.toString() + ')();';

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
