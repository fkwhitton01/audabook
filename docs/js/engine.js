/* Audabook — audio engine: playback through Web Audio, microphone capture, and the clip scheduler
   shared by live playback and export (so what you hear is exactly what gets exported). */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const FADE = 0.003; // a 3 ms fade at cut points, so edits never click

  // True when clip b carries straight on from clip a in the same audio (e.g. after a split).
  function continues(a, b) {
    return !!(a && b && a.src === b.src &&
      Math.abs(a.start + a.dur - b.start) < 1e-6 && Math.abs(a.offset + a.dur - b.offset) < 1e-6);
  }

  /**
   * Schedules a track's clips into `dest`, playing song time `from`..`to` (to = null: to the end)
   * starting at context time `startAt`. Returns the source nodes.
   */
  SS.scheduleTrack = function (ctx, dest, track, sources, from, to, startAt) {
    const nodes = [];
    const clips = track.clips;
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const src = sources.get(clip.src);
      if (!src || !src.buffer) continue;
      const cs = clip.start;
      const ce = cs + clip.dur;
      const segStart = Math.max(cs, from);
      const segEnd = to == null ? ce : Math.min(ce, to);
      const dur = segEnd - segStart;
      if (dur <= 0.0005) continue;
      const startsPlayback = segStart <= from + 1e-9;
      const endsPlayback = to != null && segEnd >= to - 1e-9;
      const cutAtStart = clip.offset > 1e-6; // the audio doesn't naturally begin here
      const cutAtEnd = clip.offset + clip.dur < src.duration - 1e-6;
      const fadeIn = segStart > cs + 1e-6 || (cutAtStart && (startsPlayback || !continues(clips[i - 1], clip)));
      const fadeOut = segEnd < ce - 1e-6 || (cutAtEnd && (endsPlayback || !continues(clip, clips[i + 1])));
      const when = startAt + (segStart - from);
      const node = ctx.createBufferSource();
      node.buffer = src.buffer;
      let target = dest;
      if (fadeIn || fadeOut) {
        const g = ctx.createGain();
        g.connect(dest);
        target = g;
        const f = Math.min(FADE, dur / 4);
        if (fadeIn) {
          g.gain.setValueAtTime(0, when);
          g.gain.linearRampToValueAtTime(1, when + f);
        }
        if (fadeOut) {
          g.gain.setValueAtTime(1, when + dur - f);
          g.gain.linearRampToValueAtTime(0, when + dur);
        }
      }
      node.connect(target);
      node.start(when, clip.offset + (segStart - cs), dur);
      nodes.push(node);
    }
    return nodes;
  };

  // Runs inside the audio thread. Collects microphone samples and reports the input level.
  function recorderWorklet() {
    class SSRecorder extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.channels = (options.processorOptions && options.processorOptions.channels) || 1;
        this.size = 4096;
        this.bufs = [];
        for (let c = 0; c < this.channels; c++) this.bufs.push(new Float32Array(this.size));
        this.fill = 0;
        this.chunkFrame = 0;
        this.capturing = false;
        this.alive = true;
        this.peak = 0;
        this.levelFrames = 0;
        this.port.onmessage = (e) => {
          const cmd = e.data && e.data.cmd;
          if (cmd === 'start') {
            this.fill = 0;
            this.capturing = true;
          } else if (cmd === 'stop') {
            this.flush();
            this.capturing = false;
            this.port.postMessage({ type: 'stopped' });
          } else if (cmd === 'close') {
            this.alive = false;
          }
        };
      }
      flush() {
        if (!this.fill) return;
        const out = this.bufs.map((b) => b.slice(0, this.fill));
        this.port.postMessage({ type: 'data', frame: this.chunkFrame, channels: out }, out.map((a) => a.buffer));
        this.fill = 0;
      }
      process(inputs) {
        if (!this.alive) return false;
        const input = inputs[0];
        if (!input || !input.length) return true;
        const n = input[0].length;
        for (let c = 0; c < input.length; c++) {
          const d = input[c];
          for (let i = 0; i < n; i++) {
            const v = d[i] < 0 ? -d[i] : d[i];
            if (v > this.peak) this.peak = v;
          }
        }
        this.levelFrames += n;
        if (this.levelFrames >= 1024) {
          this.port.postMessage({ type: 'level', peak: this.peak });
          this.peak = 0;
          this.levelFrames = 0;
        }
        if (this.capturing) {
          // Some USB mics send sound on only one side, so a dead channel is replaced by the live one.
          const a = input[0];
          const b = input.length > 1 ? input[1] : a;
          let left = a;
          let right = b;
          if (b !== a) {
            let ea = 0;
            let eb = 0;
            for (let i = 0; i < n; i++) {
              ea += a[i] * a[i];
              eb += b[i] * b[i];
            }
            if (eb <= ea * 1e-7) right = a;
            else if (ea <= eb * 1e-7) left = b;
          }
          let srcs = [left, right];
          if (this.channels === 1) {
            if (left === right) srcs = [left];
            else {
              if (!this.mix || this.mix.length !== n) this.mix = new Float32Array(n);
              for (let i = 0; i < n; i++) this.mix[i] = (left[i] + right[i]) * 0.5;
              srcs = [this.mix];
            }
          }
          let i = 0;
          while (i < n) {
            if (this.fill === 0) this.chunkFrame = currentFrame + i;
            const take = Math.min(n - i, this.size - this.fill);
            for (let c = 0; c < this.channels; c++) {
              this.bufs[c].set(srcs[c].subarray(i, i + take), this.fill);
            }
            this.fill += take;
            i += take;
            if (this.fill === this.size) this.flush();
          }
        }
        return true;
      }
    }
    registerProcessor('ss-recorder', SSRecorder);
  }
  const WORKLET_SOURCE = '(' + recorderWorklet.toString() + ')();';

  // Turns getUserMedia failures into instructions that make sense on a Chromebook.
  function micError(e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return new SS.UserError('Chrome isn’t allowed to use the microphone. Click the microphone or lock icon at the ' +
        'left of the address bar, choose Allow, then press Record again. Also check ChromeOS Settings → Security and ' +
        'privacy → Privacy controls → Microphone access.');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return new SS.UserError('No microphone was found. Plug one in, or check that the built-in microphone is turned on in ChromeOS Settings.');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return new SS.UserError('The microphone is busy or switched off. Close other tabs or apps using it (like a video call), ' +
        'check ChromeOS Settings → Security and privacy → Privacy controls → Microphone access, then try again.');
    }
    return new SS.UserError('The microphone couldn’t start' + (name ? ' (' + name + ')' : '') + '. Try again, or pick a different microphone in Settings.');
  }

  /** Microphone discovery: plug-and-play means picking the USB mic (e.g. a Maono) without being asked. */
  SS.mic = {
    // "MAONO AU-PM421: USB Audio:2,0" -> "MAONO AU-PM421"
    cleanLabel(label) {
      let s = String(label || '').replace(/^(default|communications)\s*-\s*/i, '');
      s = s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
      s = s.replace(/\s*:\s*usb audio.*$/i, '').replace(/\s*:\s*\d+,\d+\s*$/, '');
      return s.trim() || 'Microphone';
    },

    // Higher is better. A plugged-in mic beats the Chromebook's own; Bluetooth headsets sound worst.
    score(label) {
      const l = String(label || '').toLowerCase();
      if (/maono/.test(l)) return 100;
      if (/bluetooth|hands-?free|hfp|airpods|buds/.test(l)) return 3;
      if (/webcam|camera|c9\d\d|brio|hdmi|display/.test(l)) return 5;
      if (/internal|built-?in|integrated|front mic|rear mic|mic(rophone)? array|realtek|intel|chromebook/.test(l)) return 10;
      if (/mic jack|headset|headphone|earbud|earphone/.test(l)) return 15;
      if (/usb|podcast|condenser|studio|interface|xlr|yeti|fifine|rode|shure|samson|tonor|hyperx|razer|focusrite|scarlett|behringer|audio-technica|at20\d\d|tascam|neewer|elgato|pnp/.test(l)) return 60;
      return 40; // something plugged in that we don't recognise: probably better than the built-in mic
    },

    async listInputs() {
      const md = root.navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return [];
      try {
        const list = await md.enumerateDevices();
        return list.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      } catch (e) {
        return [];
      }
    },

    /** The best mic, or null when Chrome is hiding mic names (before access is first allowed). */
    best(inputs) {
      let best = null;
      let bestScore = -1;
      for (const d of inputs) {
        if (!d.label) return null;
        const s = SS.mic.score(d.label);
        if (s > bestScore) {
          best = d;
          bestScore = s;
        }
      }
      return best;
    },
  };

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.group = null; // nodes of the playback in progress
      this.input = null; // the open microphone
      this.onLevel = null; // (peak 0..1) while the mic is open
      this.onCaptureData = null; // (Float32Array[]) while capturing
      this.onInputLost = null; // mic unplugged or switched off
      this.workletPromise = null;
      this.metro = { on: false, bpm: 120, beatsPerBar: 4, volume: 0.55 };
      this.clickBuffers = null;
    }

    /** Metronome settings: { on, bpm, beatsPerBar }. Takes effect immediately, even mid-song. */
    setMetronome(opts) {
      const m = this.metro;
      const changed = opts.on !== m.on || opts.bpm !== m.bpm || opts.beatsPerBar !== m.beatsPerBar;
      Object.assign(m, opts);
      if (changed && this.group) this.group.clickNext = null; // re-find the next beat at the new tempo
    }

    makeClicks() {
      const ctx = this.ctx;
      const rate = ctx.sampleRate;
      const len = Math.round(rate * 0.05);
      const make = (freq, amp) => {
        const b = ctx.createBuffer(1, len, rate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) {
          const t = i / rate;
          d[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 80) * amp * Math.min(1, i / 24);
        }
        return b;
      };
      this.clickBuffers = { accent: make(1760, 1), beat: make(1175, 0.65) };
    }

    click(g, when, accent) {
      if (!this.clickBuffers) this.makeClicks();
      const n = this.ctx.createBufferSource();
      n.buffer = accent ? this.clickBuffers.accent : this.clickBuffers.beat;
      const gain = this.ctx.createGain();
      gain.gain.value = this.metro.volume;
      n.connect(gain);
      gain.connect(g.out);
      n.start(when);
      g.nodes.push(n);
    }

    // Schedules metronome clicks a little ahead of time (the song can be any length, so not all at once).
    tickClicks(g) {
      if (this.group !== g) {
        clearInterval(g.clickTimer);
        return;
      }
      const m = this.metro;
      if (!m.on || !(m.bpm > 0)) {
        g.clickNext = null;
        return;
      }
      const ctx = this.ctx;
      const spb = 60 / m.bpm;
      if (g.clickNext == null) {
        const songNow = g.from + Math.max(0, ctx.currentTime - g.startAt);
        g.clickNext = Math.ceil(songNow / spb - 1e-6);
      }
      const horizon = ctx.currentTime + (document.hidden ? 1.2 : 0.25);
      for (let guard = 0; guard < 256; guard++) {
        const songT = g.clickNext * spb;
        if (g.to != null && songT >= g.to - 1e-6) break;
        const when = g.startAt + (songT - g.from);
        if (when > horizon) break;
        if (when >= ctx.currentTime) this.click(g, when, g.clickNext % m.beatsPerBar === 0);
        g.clickNext++;
      }
    }

    ensureContext() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) throw new SS.UserError('This browser can’t play audio. Please update Chrome.');
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    get sampleRate() {
      return this.ctx ? this.ctx.sampleRate : 0;
    }

    get playing() {
      return !!this.group;
    }

    /**
     * Plays song time from..to (to = null: to the end). Returns the context time the song starts.
     * opts: { excludeTrack, countIn (seconds of metronome clicks before the song starts) }
     */
    play(project, sources, from, to, opts) {
      opts = opts || {};
      this.stopPlayback();
      const ctx = this.ensureContext();
      const countIn = opts.countIn || 0;
      const startAt = ctx.currentTime + 0.06 + countIn;
      const out = ctx.createGain();
      out.connect(this.master);
      const group = { out, nodes: [], tracks: new Map(), from, to, startAt, clickNext: null, clickTimer: 0 };
      if (countIn > 0) {
        const spb = 60 / this.metro.bpm;
        const n = Math.round(countIn / spb);
        for (let i = 0; i < n; i++) this.click(group, startAt - countIn + i * spb, i === 0);
      }
      for (const track of project.tracks) {
        if (track.id === opts.excludeTrack) continue;
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        gain.connect(pan);
        pan.connect(out);
        const tn = { gain, pan };
        group.tracks.set(track.id, tn);
        this.applyTrack(tn, project, track, true);
        const nodes = SS.scheduleTrack(ctx, gain, track, sources, from, to, startAt);
        for (const n of nodes) group.nodes.push(n);
      }
      this.group = group;
      group.clickTimer = setInterval(() => this.tickClicks(group), 40);
      this.tickClicks(group);
      return startAt;
    }

    applyTrack(tn, project, track, immediate) {
      const g = M.isAudible(project, track) ? SS.dbToGain(track.gain) : 0;
      if (immediate) {
        tn.gain.gain.value = g;
        tn.pan.pan.value = track.pan;
      } else {
        const t = this.ctx.currentTime;
        tn.gain.gain.setTargetAtTime(g, t, 0.012);
        tn.pan.pan.setTargetAtTime(track.pan, t, 0.012);
      }
    }

    /** Volume, pan, mute and solo changes take effect during playback without restarting it. */
    updateMix(project) {
      if (!this.group) return;
      for (const track of project.tracks) {
        const tn = this.group.tracks.get(track.id);
        if (tn) this.applyTrack(tn, project, track, false);
      }
    }

    /** The song position being heard right now, or null when stopped. */
    position() {
      const g = this.group;
      if (!g) return null;
      const ctx = this.ctx;
      let now = ctx.currentTime;
      if (ctx.getOutputTimestamp) {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
          now = Math.min(ctx.currentTime, ts.contextTime + (root.performance.now() - ts.performanceTime) / 1000);
        }
      }
      return g.from + Math.max(0, now - g.startAt);
    }

    stopPlayback() {
      const g = this.group;
      if (!g) return;
      this.group = null;
      clearInterval(g.clickTimer);
      try {
        g.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.005); // quick fade, no click
      } catch (e) { /* context closed */ }
      setTimeout(() => {
        for (const n of g.nodes) {
          try { n.stop(); } catch (e) { /* already stopped */ }
          try { n.disconnect(); } catch (e) { /* already gone */ }
        }
        try { g.out.disconnect(); } catch (e) { /* already gone */ }
      }, 60);
    }

    outputLatency() {
      const c = this.ctx;
      if (!c) return 0;
      return SS.finite(c.outputLatency, 0) || SS.finite(c.baseLatency, 0);
    }

    /**
     * Opens the microphone. settings: { deviceId ('' = pick automatically), stereo, musicMode }.
     * Automatic mode prefers a plugged-in USB mic over the Chromebook's built-in one.
     */
    async openInput(settings) {
      if (this.input) return this.input;
      const ctx = this.ensureContext();
      const md = root.navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        throw new SS.UserError('Recording only works when the app is opened from a secure (https) web address or from a file on this computer.');
      }
      if (!ctx.audioWorklet) throw new SS.UserError('This version of Chrome is too old to record. Please update your Chromebook.');
      const music = settings.musicMode !== false;
      const channels = settings.stereo ? 2 : 1;
      // Chrome's voice-call filters (echo/noise/auto-volume) wreck singing and instruments, so they're off by default.
      const constraints = (deviceId) => ({
        audio: Object.assign(
          { echoCancellation: !music, noiseSuppression: !music, autoGainControl: !music },
          deviceId ? { deviceId: { exact: deviceId } } : {}
        ),
      });
      const open = async (deviceId) => {
        try {
          return await md.getUserMedia(constraints(deviceId));
        } catch (e) {
          if (!deviceId || !/^(OverconstrainedError|NotFoundError|NotReadableError|AbortError)$/.test(e.name)) throw micError(e);
          try {
            return await md.getUserMedia(constraints('')); // that mic was unplugged: use whatever ChromeOS has
          } catch (e2) {
            throw micError(e2);
          }
        }
      };
      const automatic = !settings.deviceId;
      let wanted = settings.deviceId || '';
      if (automatic) {
        const best = SS.mic.best(await SS.mic.listInputs());
        if (best) wanted = best.deviceId;
      }
      let stream = await open(wanted);
      if (automatic) {
        // The very first time, Chrome hides mic names until access is allowed, so look again now.
        const best = SS.mic.best(await SS.mic.listInputs());
        const t = stream.getAudioTracks()[0];
        const got = t && t.getSettings ? t.getSettings().deviceId : '';
        if (best && best.deviceId !== got) {
          try {
            const better = await md.getUserMedia(constraints(best.deviceId));
            stream.getTracks().forEach((x) => x.stop());
            stream = better;
          } catch (e) { /* keep the mic we already have */ }
        }
      }
      try {
        await this.loadWorklet();
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw new SS.UserError('Recording couldn’t start in this browser. Please update Chrome and try again.');
      }
      const source = ctx.createMediaStreamSource(stream);
      // Always take two raw channels; the worklet works out which ones carry sound.
      const node = new AudioWorkletNode(ctx, 'ss-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: { channels },
      });
      // The node must feed the output for Chrome to keep running it; this gain keeps it silent.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      const track = stream.getAudioTracks()[0];
      const st = (track && track.getSettings && track.getSettings()) || {};
      const input = {
        stream, source, node, sink, channels,
        latency: SS.finite(st.latency, 0),
        label: SS.mic.cleanLabel(track ? track.label : ''),
        deviceId: st.deviceId || '',
        capture: null,
      };
      node.port.onmessage = (e) => this.onWorkletMessage(input, e.data);
      if (track) {
        track.addEventListener('ended', () => {
          if (this.input === input && this.onInputLost) this.onInputLost();
        });
      }
      this.input = input;
      return input;
    }

    onWorkletMessage(input, msg) {
      if (msg.type === 'level') {
        if (this.onLevel && this.input === input) this.onLevel(msg.peak);
        return;
      }
      const cap = input.capture;
      if (!cap) return;
      if (msg.type === 'data') {
        if (cap.firstFrame == null) cap.firstFrame = msg.frame;
        cap.chunks.push(msg.channels);
        cap.frames += msg.channels[0].length;
        if (this.onCaptureData) this.onCaptureData(msg.channels);
      } else if (msg.type === 'stopped' && cap.resolveStop) {
        cap.resolveStop();
      }
    }

    startCapture() {
      const input = this.input;
      if (!input) throw new Error('The microphone is not open.');
      input.capture = { chunks: [], frames: 0, firstFrame: null, resolveStop: null };
      input.node.port.postMessage({ cmd: 'start' });
    }

    /** Ends the capture. Resolves to { buffer, firstFrame }; buffer is null if no audio arrived. */
    async stopCapture() {
      const input = this.input;
      const cap = input && input.capture;
      if (!cap) return { buffer: null, firstFrame: 0 };
      await new Promise((resolve) => {
        cap.resolveStop = resolve;
        input.node.port.postMessage({ cmd: 'stop' });
        setTimeout(resolve, 1500); // never hang if the audio thread is gone
      });
      input.capture = null;
      if (!cap.frames) return { buffer: null, firstFrame: 0 };
      const buffer = new AudioBuffer({ numberOfChannels: input.channels, length: cap.frames, sampleRate: this.ctx.sampleRate });
      let offset = 0;
      for (const chunk of cap.chunks) {
        for (let c = 0; c < input.channels; c++) buffer.copyToChannel(chunk[c], c, offset);
        offset += chunk[0].length;
      }
      cap.chunks.length = 0;
      return { buffer, firstFrame: cap.firstFrame };
    }

    closeInput() {
      const input = this.input;
      if (!input) return;
      this.input = null;
      try { input.node.port.postMessage({ cmd: 'close' }); } catch (e) { /* gone */ }
      try {
        input.source.disconnect();
        input.node.disconnect();
        input.sink.disconnect();
      } catch (e) { /* gone */ }
      input.stream.getTracks().forEach((t) => t.stop());
      if (this.onLevel) this.onLevel(0);
    }

    loadWorklet() {
      if (!this.workletPromise) {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        const p = this.ctx.audioWorklet.addModule(url);
        this.workletPromise = p;
        p.then(() => URL.revokeObjectURL(url), () => {
          URL.revokeObjectURL(url);
          this.workletPromise = null;
        });
      }
      return this.workletPromise;
    }
  }

  SS.AudioEngine = AudioEngine;
})(window);
