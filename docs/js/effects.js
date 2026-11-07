/* Audabook — track effects: Auto-Tune, Vocal Polish, Echo, Reverb.
   Each track can have each effect once; they always run in that order (tune first, space last).
   The same chain is used for playback, for exporting, and (Auto-Tune only, in its low-latency mode)
   for hearing yourself live while recording. Effects never change the recording itself. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const NOTE_NAMES = SS.model.NOTE_NAMES; // the effect list and settings live in model.js (they're saved with songs)

  /** Seconds of delay Auto-Tune adds (measured equal to what the engine reports). */
  SS.autotuneLatency = function (rate, live) {
    const base = rate < 64000 ? 1024 : rate < 128000 ? 2048 : 4096;
    return ((live ? base / 8 : base) + (rate < 64000 ? 32 : 0)) / rate;
  };

  /** Total delay of a track's switched-on effects, in seconds (only Auto-Tune has any). */
  SS.fxLatency = function (list, rate, live) {
    return (list || []).some((f) => f.on && f.type === 'autotune') ? SS.autotuneLatency(rate, live) : 0;
  };

  // ---- Vocal Polish's compressor ------------------------------------------------------------
  // Written here rather than using Chrome's DynamicsCompressorNode, which (measured) turns mono into stereo
  // (+3 dB through the track's panner), adds its own hidden makeup boost (+1.5..12 dB) and a 6 ms delay.
  // This one keeps mono as mono, has no delay, and does only what its settings say.
  function compressorDSP() {
    class Compressor {
      constructor(rate) {
        this.rate = rate;
        this.env = 0; // current gain reduction, dB (<= 0)
        this.set({ threshold: -20, ratio: 2, knee: 8, attack: 0.005, release: 0.12, makeup: 0 });
      }
      set(o) {
        for (const k of ['threshold', 'ratio', 'knee', 'attack', 'release', 'makeup']) if (typeof o[k] === 'number' && isFinite(o[k])) this[k] = o[k];
        this.aA = Math.exp(-1 / (this.attack * this.rate));
        this.aR = Math.exp(-1 / (this.release * this.rate));
      }
      /** Gain change in dB for a level in dB (soft knee). */
      curve(xdB) {
        const over = xdB - this.threshold;
        const w = this.knee;
        const s = 1 / this.ratio - 1;
        if (2 * over <= -w) return 0;
        if (2 * over < w) return (s * (over + w / 2) * (over + w / 2)) / (2 * w);
        return s * over;
      }
      /** inp, out: arrays of channels (Float32Array); the loudest channel drives all of them (linked). */
      process(inp, out) {
        const n = out[0].length;
        const chans = Math.min(inp.length, out.length);
        for (let i = 0; i < n; i++) {
          let lvl = 0;
          for (let c = 0; c < chans; c++) {
            const v = inp[c][i] < 0 ? -inp[c][i] : inp[c][i];
            if (v > lvl) lvl = v;
          }
          const target = lvl > 1e-6 ? this.curve(20 * Math.log10(lvl)) : 0;
          this.env = target < this.env ? this.aA * this.env + (1 - this.aA) * target : this.aR * this.env + (1 - this.aR) * target;
          const g = Math.pow(10, (this.env + this.makeup) / 20);
          for (let c = 0; c < chans; c++) out[c][i] = inp[c][i] * g;
        }
        for (let c = chans; c < out.length; c++) out[c].fill(0);
      }
    }
    return { Compressor };
  }

  function compressorProcessor() {
    class CompressorProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.c = new COMP.Compressor(sampleRate);
        this.c.set((options && options.processorOptions) || {});
        this.alive = true;
        this.port.onmessage = (e) => {
          if (e.data && e.data.close) this.alive = false;
          else this.c.set(e.data || {});
        };
      }
      process(inputs, outputs) {
        if (!this.alive) return false;
        const inp = inputs[0];
        const out = outputs[0];
        if (!inp || !inp.length) {
          for (const o of out) o.fill(0);
          return true;
        }
        this.c.process(inp, out);
        return true;
      }
    }
    registerProcessor('ss-compressor', CompressorProcessor);
  }

  SS.Compressor = compressorDSP().Compressor;

  /** Vocal Polish's compressor settings for its Amount (0..1). */
  SS.polishParams = (amount) => ({
    threshold: -12 - 16 * amount,
    ratio: 1.5 + 2.5 * amount,
    knee: 8,
    attack: 0.005,
    release: 0.12,
    makeup: POLISH_MAKEUP_DB * amount,
  });

  // Effects that run on the audio thread: until that code has loaded, playback leaves them out.
  SS.WORKLET_FX = ['autotune', 'polish'];
  SS.needsWorklet = (tracks) => tracks.some((t) => (t.fx || []).some((f) => f.on && SS.WORKLET_FX.indexOf(f.type) >= 0));

  // Auto-Tune and the compressor, loaded onto the audio thread once per audio context.
  SS.FX_WORKLET = SS.AUTOTUNE_WORKLET + '\nconst COMP = (' + compressorDSP.toString() + ')();\n(' +
    compressorProcessor.toString() + ')();';
  const loaded = new WeakMap();
  SS.loadFx = function (ctx) {
    if (!loaded.has(ctx)) {
      const url = URL.createObjectURL(new Blob([SS.FX_WORKLET], { type: 'application/javascript' }));
      const p = ctx.audioWorklet.addModule(url);
      p.then(() => URL.revokeObjectURL(url), () => URL.revokeObjectURL(url));
      loaded.set(ctx, p);
    }
    return loaded.get(ctx);
  };

  // Vocal Polish's loudness boost at full Amount, in dB (calibrated by measurement; see the tests).
  const POLISH_MAKEUP_DB = 9;

  // A room: decaying stereo noise, the same every time (so playback and export sound identical).
  // Made once per audio context and size, since playback restarts after every edit.
  const rooms = new WeakMap();
  function impulse(ctx, size) {
    let cache = rooms.get(ctx);
    if (!cache) rooms.set(ctx, (cache = new Map()));
    const key = Math.round(size * 100);
    if (!cache.has(key)) {
      if (cache.size > 8) cache.clear(); // dragging the Size slider makes many; keep memory small
      cache.set(key, makeRoom(ctx, key / 100));
    }
    return cache.get(key);
  }

  function makeRoom(ctx, size) {
    const seconds = 0.6 + size * 3.2;
    const n = Math.round(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const decay = 6.9 / seconds; // -60 dB at the end
    const pre = Math.round(0.012 * ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let s = c ? 99991 : 12345;
      let energy = 0;
      for (let i = pre; i < n; i++) {
        s = (s * 16807) % 2147483647;
        const t = (i - pre) / ctx.sampleRate;
        d[i] = ((s / 2147483647) * 2 - 1) * Math.exp(-decay * t);
        energy += d[i] * d[i];
      }
      // The room's total energy is 1, so the reverb is about as loud as the dry voice at Amount 100%.
      const k = 1 / Math.sqrt(energy || 1);
      for (let i = pre; i < n; i++) d[i] *= k;
    }
    return buf;
  }

  const STAGES = {
    autotune(ctx, fx, o) {
      // No outputChannelCount: the tuned voice comes out with as many channels as went in, so Chrome's
      // panner treats the track exactly as it did without Auto-Tune.
      const node = new AudioWorkletNode(ctx, 'ss-autotune', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { key: o.songKey || 'any', style: fx.style, fast: !!o.live },
      });
      return {
        input: node,
        output: node,
        latency: SS.autotuneLatency(ctx.sampleRate, !!o.live),
        update(f, oo) { node.port.postMessage({ key: oo.songKey || 'any', style: f.style }); },
        dispose() { node.port.postMessage({ close: true }); },
      };
    },

    polish(ctx, fx) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      // No outputChannelCount: the output has as many channels as the input (mono stays mono).
      const comp = new AudioWorkletNode(ctx, 'ss-compressor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: SS.polishParams(fx.amount),
      });
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 7000;
      hp.connect(comp);
      comp.connect(shelf);
      const set = (f) => {
        comp.port.postMessage(SS.polishParams(f.amount));
        shelf.gain.value = 5 * f.amount;
      };
      shelf.gain.value = 5 * fx.amount;
      return { input: hp, output: shelf, latency: 0, update: set, dispose() { comp.port.postMessage({ close: true }); } };
    },

    echo(ctx, fx, o) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const delay = ctx.createDelay(4);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 4500;
      const wet = ctx.createGain();
      input.connect(output); // dry
      input.connect(delay);
      delay.connect(tone);
      tone.connect(fb);
      fb.connect(delay);
      tone.connect(wet);
      wet.connect(output);
      const set = (f, oo) => {
        delay.delayTime.value = Math.min(3.9, (60 / ((oo && oo.bpm) || 120)) * SS.ECHO_TIMINGS[f.timing]);
        fb.gain.value = 0.7 * f.repeats;
        wet.gain.value = f.amount;
      };
      set(fx, o);
      return { input, output, latency: 0, update: set };
    },

    // Reverb comes after the track's Vol and Pan (see POST): it turns sound stereo, and before the pan that
    // would make a mono vocal 3 dB louder (Chrome pans mono and stereo sound differently).
    reverb(ctx, fx) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const wet = ctx.createGain();
      input.connect(output); // dry
      input.connect(conv);
      conv.connect(wet);
      wet.connect(output);
      let size = -1;
      const set = (f) => {
        if (f.size !== size) {
          size = f.size;
          conv.buffer = impulse(ctx, size);
        }
        wet.gain.value = f.amount * 0.9;
      };
      set(fx);
      return { input, output, latency: 0, update: set };
    },
  };

  // Effects that go after the track's Vol and Pan instead of before them.
  const POST = { reverb: true };

  /**
   * Builds a track's chain of switched-on effects. opts: { songKey, bpm, live, skip: [types to leave out],
   * part: 'pre' (before Vol/Pan) | 'post' (after them) | undefined (all) }.
   * Returns { input, output, latency (seconds), shape, update(fxList, opts), dispose() }.
   * Auto-Tune needs SS.loadFx(ctx) to have finished first.
   */
  SS.buildFxChain = function (ctx, fxList, opts) {
    opts = opts || {};
    const input = ctx.createGain();
    const output = ctx.createGain();
    const stages = [];
    let node = input;
    let latency = 0;
    for (const type of SS.FX_ORDER) {
      const fx = (fxList || []).find((f) => f.type === type && f.on);
      if (!fx || (opts.skip && opts.skip.indexOf(type) >= 0)) continue;
      if ((opts.part === 'pre' && POST[type]) || (opts.part === 'post' && !POST[type])) continue;
      const stage = STAGES[type](ctx, fx, opts);
      node.connect(stage.input);
      node = stage.output;
      latency += stage.latency;
      stages.push({ type, stage });
    }
    node.connect(output);
    return {
      input,
      output,
      latency,
      // Which effects are on, in order: if this changes, the chain must be rebuilt rather than updated.
      shape: stages.map((s) => s.type).join(','),
      update(list, o) {
        for (const s of stages) {
          const fx = list.find((f) => f.type === s.type && f.on);
          if (fx) s.stage.update(fx, o || {});
        }
      },
      dispose() {
        for (const s of stages) if (s.stage.dispose) s.stage.dispose();
      },
    };
  };

  // ---- finding the key of a beat ----------------------------------------------------------
  // Krumhansl-Kessler key profiles.
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function correlate(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / 12;
    const mb = b.reduce((s, v) => s + v, 0) / 12;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db || 1);
  }

  /** How much of each of the 12 notes is in some audio (adds into `chroma`). */
  SS.addChroma = function (channels, rate, from, to, chroma) {
    const N = 8192;
    const fft = new SS.AutoTune.FFT(N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    const lo = Math.ceil((55 * N) / rate);
    const hi = Math.floor((2000 * N) / rate);
    const pc = new Int8Array(hi + 1);
    for (let b = lo; b <= hi; b++) pc[b] = ((Math.round(12 * Math.log2((b * rate) / N / 440)) % 12) + 12 + 9) % 12;
    const hop = N;
    for (let s = from; s + N <= to; s += hop) {
      for (let i = 0; i < N; i++) {
        let v = 0;
        for (const ch of channels) v += ch[s + i];
        re[i] = v * win[i];
        im[i] = 0;
      }
      fft.transform(re, im, false);
      for (let b = lo; b <= hi; b++) chroma[pc[b]] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }
  };

  /** "C major" -> "A minor" and back: two names for the same seven notes (which is all Auto-Tune uses). */
  SS.relativeKey = function (key) {
    const m = /^([A-G]#?) (major|minor)$/.exec(key || '');
    if (!m) return '';
    const i = NOTE_NAMES.indexOf(m[1]);
    return m[2] === 'major' ? NOTE_NAMES[(i + 9) % 12] + ' minor' : NOTE_NAMES[(i + 3) % 12] + ' major';
  };

  /** Best-matching key for a chroma vector: { key, r (how well it matches), margin (how clearly it wins) }. */
  SS.keyFromChroma = function (chroma) {
    const scores = [];
    for (let t = 0; t < 12; t++) {
      for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]]) {
        const rotated = prof.map((_, i) => prof[(i - t + 12) % 12]);
        const key = NOTE_NAMES[t] + ' ' + mode;
        scores.push({ key, mask: SS.AutoTune.keyMask(key), r: correlate(chroma, rotated) });
      }
    }
    scores.sort((a, b) => b.r - a.r);
    const best = scores[0];
    // How clearly it wins against the best key with *different* notes (C major vs A minor is no contest:
    // they share every note, and the notes are all Auto-Tune needs).
    const rival = scores.find((s) => s.mask !== best.mask);
    return { key: best.key, r: best.r, margin: best.r - rival.r };
  };

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
