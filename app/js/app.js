/* Audabook — the app: state, actions, menus, keyboard shortcuts, recording, import/export, autosave. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const UI = SS.ui;
  const el = UI.el;

  const SETTINGS_KEY = 'audabook.settings.v1';
  const SEEN_KEY = 'audabook.quickstart.v1';
  const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|mp4|m4v|mov|ogg|oga|opus|flac|webm|weba|aif|aiff|3gp)$/i;
  const DEFAULT_SETTINGS = {
    deviceId: '', // '' = pick the best mic automatically (a plugged-in USB mic beats the built-in one)
    stereo: false,
    musicMode: true,
    autoLevel: true,
    metronome: false,
    latencyMs: 0,
    theme: 'auto',
    exportBits: 24,
    exportRate: 0,
    exportApplyMix: true,
    exportIncludeMix: false,
    exportTo: 'folder',
  };

  function loadSettings() {
    try {
      const s = JSON.parse(root.localStorage.getItem(SETTINGS_KEY) || '{}');
      return Object.assign({}, DEFAULT_SETTINGS, s && typeof s === 'object' ? s : {});
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function storageFlag(key, set) {
    try {
      if (set) root.localStorage.setItem(key, '1');
      return root.localStorage.getItem(key) === '1';
    } catch (e) {
      return true; // storage blocked: don't nag every visit
    }
  }

  function makeSource(id, name, buffer) {
    const channels = SS.channelsOf(buffer);
    return {
      id, name, buffer, channels,
      rate: buffer.sampleRate,
      length: buffer.length,
      duration: buffer.duration,
      peaks: SS.computePeaks(channels, buffer.length),
    };
  }

  const app = {
    project: M.newProject('My Song', 48000),
    sources: new Map(),
    history: new SS.History(100),
    clipboard: null,
    gesture: null, // serialized state from before a drag/slider gesture began
    state: {
      cursor: 0,
      sel: { t0: 0, t1: 0, tracks: new Set() },
      playing: false,
      playRange: null,
      playFrom: 0,
      playEnd: 0,
      recording: null,
      starting: false,
      monitoring: false,
    },
    settings: loadSettings(),
    engine: new SS.AudioEngine(),
    store: new SS.Store(),
    pendingWrites: new Set(),
    saveDirty: false,
    lastSaved: 0,
  };
  SS.app = app;

  app.saveSettings = function () {
    try {
      root.localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
    } catch (e) { /* storage blocked */ }
  };

  app.sampleRate = () => app.engine.sampleRate || app.project.sampleRate || 48000;

  app.playheadTime = function () {
    if (app.state.playing) {
      const p = app.engine.position();
      if (p != null) return p;
    }
    return app.state.cursor;
  };

  // ---- live recording (drawn by the timeline while it happens) ------------------------------

  // Samples captured before the song starts (the count-in, and a moment of lead-in) aren't part of the take.
  function leadFrames(rec) {
    const cap = app.engine.input && app.engine.input.capture;
    if (rec.lead == null && cap && cap.firstFrame != null) {
      rec.lead = Math.max(0, Math.round(rec.playStart * rec.rate - cap.firstFrame));
    }
    return rec.lead || 0;
  }

  app.liveEnd = function () {
    const rec = app.state.recording;
    return rec ? rec.from + Math.max(0, rec.peaks.length - leadFrames(rec)) / rec.rate : 0;
  };

  app.liveRecording = function (trackId) {
    const rec = app.state.recording;
    if (!rec || rec.trackId !== trackId) return null;
    const lead = leadFrames(rec);
    if (rec.peaks.length <= lead) return null;
    return {
      clip: { start: rec.from, offset: lead / rec.rate, dur: (rec.peaks.length - lead) / rec.rate },
      src: { rate: rec.rate, length: rec.peaks.length, channels: null, peaks: rec.peaks, name: 'Recording' },
    };
  };

  // ---- state changes & undo ------------------------------------------------------------------

  app.serialize = () => M.serializeState(app.project);

  app.restoreState = function (json) {
    const s = JSON.parse(json);
    app.project.name = s.name;
    app.project.bpm = s.bpm;
    app.project.beatsPerBar = s.beatsPerBar;
    app.project.showBeats = s.showBeats;
    app.project.tracks = s.tracks;
    const ids = new Set(s.tracks.map((t) => t.id));
    app.state.sel.tracks = new Set(Array.from(app.state.sel.tracks).filter((id) => ids.has(id)));
    app.changed();
  };

  /** Runs fn(project) as one undoable step. Nothing is recorded if fn changes nothing. */
  app.edit = function (label, fn, opts) {
    if (app.state.recording) {
      app.status('Stop recording first.');
      return undefined;
    }
    if (app.gesture != null) app.endGesture('Edit');
    const before = app.serialize();
    const result = fn(app.project);
    if (app.serialize() !== before) {
      app.history.push({ label, state: before });
      app.changed(opts);
    }
    return result;
  };

  // Drags and slider moves change the project live, then become one undo step when they end.
  app.beginGesture = function () {
    if (app.gesture == null) app.gesture = app.serialize();
  };

  app.endGesture = function (label, opts) {
    if (app.gesture == null) return false;
    const before = app.gesture;
    app.gesture = null;
    if (app.serialize() === before) return false;
    app.history.push({ label, state: before });
    app.changed(opts);
    return true;
  };

  app.abortGesture = function () {
    if (app.gesture == null) return;
    const before = app.gesture;
    app.gesture = null;
    app.restoreState(before);
  };

  app.changed = function (opts) {
    opts = opts || {};
    app.syncTempo();
    app.timeline.syncRows();
    if (opts.mix) app.engine.updateMix(app.project);
    else app.reschedule();
    app.timeline.invalidate();
    app.refreshUI();
    app.scheduleAutosave();
  };

  // During a drag: keep the scrollbar honest without the cost of a full update.
  app.liveEdit = function () {
    app.timeline.updateScrollbar();
  };

  app.undo = function () {
    if (app.state.recording) return;
    if (app.gesture != null) app.endGesture('Edit');
    const entry = app.history.undo(app.serialize());
    if (!entry) return;
    app.restoreState(entry.state);
    app.status('Undid: ' + entry.label);
  };

  app.redo = function () {
    if (app.state.recording) return;
    const entry = app.history.redo(app.serialize());
    if (!entry) return;
    app.restoreState(entry.state);
    app.status('Redid: ' + entry.label);
  };

  // ---- selection --------------------------------------------------------------------------

  app.hasRange = function () {
    const s = app.state.sel;
    return s.t1 - s.t0 > 1e-6 && s.tracks.size > 0;
  };

  app.selectedTracks = () => app.project.tracks.filter((t) => app.state.sel.tracks.has(t.id));

  app.setSelection = function (t0, t1, trackIds) {
    const s = app.state.sel;
    s.t0 = Math.max(0, Math.min(t0, t1));
    s.t1 = Math.max(0, t0, t1);
    if (trackIds) s.tracks = new Set(trackIds);
    if (!app.state.playing) app.state.cursor = s.t0;
    app.timeline.selectionChanged();
    app.refreshUI();
    app.updateTime();
  };

  app.clickLane = function (trackId, t, shift, ctrl) {
    const s = app.state.sel;
    if (shift) {
      app.setSelection(Math.min(s.t0, t), Math.max(s.t1, t), Array.from(s.tracks).concat([trackId]));
      return;
    }
    if (ctrl) {
      const ids = new Set(s.tracks);
      if (ids.has(trackId)) ids.delete(trackId);
      else ids.add(trackId);
      app.setSelection(s.t0, s.t1, Array.from(ids));
      return;
    }
    app.setSelection(t, t, [trackId]);
    if (app.state.playing && !app.state.recording) app.seek(t);
  };

  app.selectTrack = function (id, additive) {
    const s = app.state.sel;
    let ids = [id];
    if (additive) {
      const set = new Set(s.tracks);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      ids = Array.from(set);
    }
    app.setSelection(s.t0, s.t1, ids);
  };

  app.selectAll = function () {
    app.setSelection(0, M.projectEnd(app.project), app.project.tracks.map((t) => t.id));
  };

  app.selectNone = function () {
    const c = app.state.playing ? app.state.cursor : app.state.sel.t0;
    app.setSelection(c, c, []);
  };

  // ---- transport --------------------------------------------------------------------------

  app.seek = function (t) {
    t = Math.max(0, t);
    const st = app.state;
    if (st.recording) return;
    if (st.playing) {
      st.playRange = null;
      st.playFrom = t;
      app.engine.play(app.project, app.sources, t, null);
      st.playEnd = M.projectEnd(app.project);
      return;
    }
    st.cursor = t;
    st.sel.t0 = st.sel.t1 = t;
    app.afterStop();
  };

  app.play = function () {
    const st = app.state;
    if (st.recording || st.playing) return;
    const end = M.projectEnd(app.project);
    if (end <= 0) {
      app.status('Nothing to play yet. Import a song or press Record first.');
      return;
    }
    let from = st.cursor;
    let to = null;
    if (st.sel.t1 - st.sel.t0 > 1e-6) {
      from = st.sel.t0;
      to = st.sel.t1;
    }
    if (to == null && from >= end - 0.05) from = 0; // at the end: start over
    app.engine.play(app.project, app.sources, from, to);
    st.playing = true;
    st.playFrom = from;
    st.playRange = to != null ? { from, to } : null;
    st.playEnd = to != null ? to : end;
    app.startTicker();
    app.refreshUI();
  };

  // Stop where we are (Space / the play button).
  app.pause = function () {
    const st = app.state;
    if (st.recording) return app.stopRecording();
    if (!st.playing) return;
    const pos = Math.min(app.playheadTime(), st.playEnd);
    app.engine.stopPlayback();
    st.playing = false;
    if (st.playRange) st.cursor = st.playRange.from;
    else {
      st.cursor = pos;
      st.sel.t0 = st.sel.t1 = pos;
    }
    st.playRange = null;
    app.afterStop();
  };

  // Stop and go back to where playback started (the ■ button).
  app.stop = function () {
    const st = app.state;
    if (st.recording) return app.stopRecording();
    if (!st.playing) return;
    app.engine.stopPlayback();
    st.playing = false;
    st.cursor = st.playFrom;
    if (!st.playRange) st.sel.t0 = st.sel.t1 = st.playFrom;
    st.playRange = null;
    app.afterStop();
  };

  app.togglePlay = function () {
    const st = app.state;
    if (st.recording) app.stopRecording();
    else if (st.playing) app.pause();
    else app.play();
  };

  app.afterStop = function () {
    app.timeline.selectionChanged();
    app.updateTime();
    app.refreshUI();
  };

  app.reschedule = function () {
    const st = app.state;
    if (!st.playing || st.recording) return;
    const pos = app.playheadTime();
    const to = st.playRange ? st.playRange.to : null;
    st.playEnd = to != null ? to : M.projectEnd(app.project);
    if (pos >= st.playEnd) {
      app.pause();
      return;
    }
    app.engine.play(app.project, app.sources, pos, to);
  };

  app.goStart = function () {
    if (app.state.recording) return;
    app.seek(0);
    app.timeline.showTime(0);
  };

  app.goEnd = function () {
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    const end = M.projectEnd(app.project);
    app.seek(end);
    app.timeline.showTime(end);
  };

  app.nudge = function (dt) {
    if (app.state.recording) return;
    const t = Math.max(0, app.playheadTime() + dt);
    app.seek(t);
    app.timeline.showTime(t);
  };

  app.startTicker = function () {
    if (!app.ticker) app.ticker = requestAnimationFrame(app.tick);
  };

  app.tick = function () {
    app.ticker = 0;
    const st = app.state;
    if (!st.playing) return;
    const pos = app.playheadTime();
    app.timeline.followPlayhead(pos);
    app.timeline.updatePlayhead(pos);
    app.updateTime(pos);
    if (st.recording) {
      const now = root.performance.now();
      if (now - st.recording.lastDraw > 90) {
        st.recording.lastDraw = now;
        app.timeline.invalidate(st.recording.trackId);
      }
    } else if (pos >= st.playEnd) {
      if (st.playRange) app.stop();
      else app.pause();
      return;
    }
    app.ticker = requestAnimationFrame(app.tick);
  };

  // ---- recording --------------------------------------------------------------------------

  /** into = true records onto the selected track (replacing what's under it); otherwise a new track. */
  app.record = async function (into) {
    const st = app.state;
    if (st.recording) return app.stopRecording();
    if (st.starting) return;
    let target = null;
    if (into) {
      target = app.selectedTracks()[0];
      if (!target) {
        UI.toast('First click a track’s name to choose where to record. Or press Record (R) to make a new track.');
        return;
      }
    }
    if (st.playing) app.pause();
    st.starting = true;
    app.refreshUI();
    try {
      app.engine.ensureContext();
      if (!(await app.micPermissionCheck())) {
        st.starting = false;
        app.refreshUI();
        return;
      }
      app.status('Starting the microphone… (if Chrome asks, choose Allow)');
      await app.engine.openInput(app.settings);
    } catch (e) {
      st.starting = false;
      app.refreshUI();
      app.status('Ready');
      app.handleError(e);
      return;
    }
    st.starting = false;
    app.onDevicesChanged(); // now that the mic is allowed, Chrome shows the mic names
    const from = st.cursor;
    app.beginGesture();
    let track = target && M.findTrack(app.project, target.id);
    if (!track) {
      track = M.createTrack(app.project, M.nextTrackName(app.project, 'Take'));
      app.project.tracks.push(track);
    }
    const overdub = app.project.tracks.some((t) => t !== track && t.clips.length && M.isAudible(app.project, t));
    // With the metronome on, one bar of clicks plays before recording starts.
    const countIn = app.settings.metronome ? (60 / app.project.bpm) * app.project.beatsPerBar : 0;
    app.syncTempo();
    const playStart = app.engine.play(app.project, app.sources, from, null, { excludeTrack: track.id, countIn });
    const rec = {
      trackId: track.id, from, playStart, overdub, countIn,
      rate: app.engine.sampleRate,
      peaks: new SS.PeakBuilder(),
      input: app.engine.input,
      lead: null,
      lastDraw: 0,
      startedAt: root.performance.now(),
    };
    app.engine.onCaptureData = (chs) => rec.peaks.append(chs);
    app.engine.onInputLost = () => {
      UI.toast('The microphone was disconnected, so recording stopped. Your take so far was kept.', { kind: 'error' });
      app.stopRecording();
    };
    app.engine.startCapture();
    st.recording = rec;
    st.playing = true;
    st.playRange = null;
    st.playFrom = from;
    st.playEnd = Infinity;
    st.sel = { t0: from, t1: from, tracks: new Set([track.id]) };
    app.timeline.syncRows();
    app.timeline.selectionChanged();
    app.timeline.invalidate();
    const row = app.timeline.rows.get(track.id);
    if (row && row.row.scrollIntoView) row.row.scrollIntoView({ block: 'nearest' });
    app.startTicker();
    app.refreshUI();
    const mic = rec.input && rec.input.label ? ' with ' + rec.input.label : '';
    app.status((countIn ? 'Count-in… then recording' : 'Recording') + ' on “' + track.name + '”' + mic +
      '. Press Space or Stop when you’re done.');
  };

  app.stopRecording = async function () {
    const st = app.state;
    const rec = st.recording;
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    let result = { buffer: null, firstFrame: 0 };
    try {
      result = await app.engine.stopCapture();
    } catch (e) {
      console.error(e);
    }
    app.engine.stopPlayback();
    app.engine.onCaptureData = null;
    app.engine.onInputLost = null;
    if (!st.monitoring) app.engine.closeInput();
    st.recording = null;
    st.playing = false;
    st.playRange = null;
    const track = M.findTrack(app.project, rec.trackId);
    const buffer = result.buffer;
    if (!track || !buffer || buffer.duration < 0.05) {
      app.abortGesture();
      st.cursor = rec.from;
      st.sel = { t0: rec.from, t1: rec.from, tracks: new Set(track && rec.into ? [track.id] : []) };
      app.afterStop();
      app.status('Nothing was recorded.');
      // Only worth a warning if it was really recording for a while (not a quick double-click).
      if (!buffer && root.performance.now() - rec.startedAt - rec.countIn * 1000 > 1500) {
        UI.toast('No sound came in from the microphone. Check that it’s plugged in, or see Help → Microphone Help.', { kind: 'error' });
      }
      return;
    }
    // Line the take up with what was playing: the sound took a moment to reach the speakers and come back in.
    const comp = (app.settings.latencyMs || 0) / 1000 +
      (rec.input ? rec.input.latency : 0) +
      (rec.overdub || rec.countIn ? app.engine.outputLatency() : 0);
    let start = rec.from + (result.firstFrame / buffer.sampleRate - rec.playStart) - comp;
    let offset = 0;
    if (start < rec.from) {
      // Drop what came in before the song started (the count-in and lead-in).
      offset = rec.from - start;
      start = rec.from;
    }
    const dur = buffer.duration - offset;
    if (dur <= 0.02) {
      app.abortGesture();
      app.afterStop();
      app.status('Nothing was recorded.');
      return;
    }
    const level = app.checkTakeLevel(buffer, offset, !rec.into);
    const src = app.addSource(buffer, track.name);
    M.insertClip(track, { id: SS.uid('c'), src: src.id, name: track.name, offset, start, dur });
    app.endGesture('Record');
    app.setSelection(start, start + dur, [track.id]);
    app.status('Recorded ' + SS.formatTime(dur, 1) + ' on “' + track.name + '”.' +
      (level.boost ? ' It was quiet, so it was turned up ' + level.boost + ' dB.' : '') +
      ' Press Space to hear it, or Backspace to delete it.');
  };

  /**
   * Looks at a finished take: warns if it's silent or distorted, and (for new tracks) turns up
   * a quiet take so a beginner never ends up with a whisper-quiet vocal. Returns { peak, boost }.
   */
  app.checkTakeLevel = function (buffer, skipSec, mayBoost) {
    const skip = Math.round(skipSec * buffer.sampleRate);
    let peak = 0;
    let clipped = 0;
    const chans = SS.channelsOf(buffer);
    for (const d of chans) {
      for (let i = skip; i < d.length; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) peak = v;
        if (v >= 0.995) clipped++;
      }
    }
    let boost = 0;
    if (peak <= 0.002) {
      UI.toast('That take came in silent. Check that the mute button on your mic is off (Maono mics usually show a red ' +
        'light when muted) and that it’s plugged in, then try again. Help → Microphone Help has more tips.', { kind: 'error', timeout: 14000 });
    } else if (clipped > 8) {
      UI.toast('Parts of that take were too loud and may sound crunchy. Turn the gain knob on your mic down a little, or sing a bit further away from it.', { kind: 'error', timeout: 12000 });
    } else if (mayBoost && app.settings.autoLevel !== false && peak < 0.125) {
      const gain = Math.min(16, 0.5 / peak); // bring the loudest moment up to about -6 dB, at most +24 dB
      for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= gain;
      boost = Math.round(20 * Math.log10(gain));
      if (peak < 0.03) {
        UI.toast('That take was very quiet, so it was turned up for you. Next time, turn up the gain knob on your mic for a cleaner sound.', { timeout: 9000 });
      }
    }
    return { peak, boost };
  };

  /** Explains Chrome's microphone question before it appears, or how to undo a "Block". */
  app.micPermissionCheck = async function () {
    let state = '';
    try {
      if (root.navigator.permissions && root.navigator.permissions.query) {
        state = (await root.navigator.permissions.query({ name: 'microphone' })).state;
      }
    } catch (e) { /* this browser can't say: just ask */ }
    if (state === 'prompt') {
      const ok = await UI.dialog({
        title: 'Getting your mic ready',
        content: el('div', null, [
          el('p', { text: 'Plug in your microphone now if it isn’t already (your Maono, or any USB mic). Audabook finds it by itself.' }),
          el('p', { text: 'Next, Chrome will ask if Audabook can use your microphone. Click Allow. You only have to do this once.' }),
        ]),
        buttons: [
          { label: 'Not now', value: false },
          { label: 'OK, continue', value: true, kind: 'primary' },
        ],
        dismissValue: false,
      });
      return !!ok;
    }
    if (state === 'denied') {
      UI.dialog({
        title: 'The microphone is blocked',
        content: '<p>Chrome was told not to let Audabook use the microphone. To fix it:</p><ol class="steps">' +
          '<li>Click the <b>lock</b> or <b>microphone</b> icon at the left end of the address bar. (In the installed app, click the ' +
          '<b>⋮</b> menu at the top right, then <b>App info</b>.)</li>' +
          '<li>Set <b>Microphone</b> to <b>Allow</b>.</li><li>Press Record again.</li></ol>',
        buttons: [{ label: 'OK', value: true, kind: 'primary' }],
      });
      return false;
    }
    return true;
  };

  // ---- microphones: plug and play ------------------------------------------------------------

  app.refreshMicName = async function (inputs) {
    inputs = inputs || (await SS.mic.listInputs());
    let name = app.engine.input ? app.engine.input.label : '';
    if (!name && app.settings.deviceId) {
      const d = inputs.find((x) => x.deviceId === app.settings.deviceId);
      if (d && d.label) name = SS.mic.cleanLabel(d.label);
    }
    if (!name) {
      const best = SS.mic.best(inputs);
      if (best) name = SS.mic.cleanLabel(best.label);
    }
    app.micName = name;
    const out = document.getElementById('mic-name');
    if (out) {
      out.textContent = name || 'Microphone';
      out.title = name ? 'Recording with: ' + name + '. Click to check its level.' : 'Click to check your microphone';
    }
  };

  app.reopenMonitor = async function () {
    if (!app.state.monitoring) return;
    app.engine.closeInput();
    app.state.monitoring = false;
    await app.toggleMonitor();
  };

  // Runs when a mic (or any audio device) is plugged in or unplugged.
  app.onDevicesChanged = async function () {
    const inputs = await SS.mic.listInputs();
    const ids = new Set(inputs.map((d) => d.deviceId));
    // Until the mic is first allowed, Chrome hides the device list, so there's nothing to compare against yet.
    const prev = app.knownMicsNamed ? app.knownMics : null;
    app.knownMics = ids;
    app.knownMicsNamed = inputs.some((d) => d.label);
    const input = app.engine.input;
    const lost = !!(input && input.deviceId && input.deviceId !== 'default' && !ids.has(input.deviceId));
    if (prev && !app.settings.deviceId) {
      const best = SS.mic.best(inputs);
      const added = inputs.filter((d) => !prev.has(d.deviceId));
      if (best && added.indexOf(best) >= 0) {
        const name = SS.mic.cleanLabel(best.label);
        UI.toast('🎙️ ' + name + ' is connected. ' +
          (app.state.recording ? 'It will be used for your next recording.' : 'Audabook will record with it.'), { kind: 'success' });
        if (app.state.monitoring && !app.state.recording) await app.reopenMonitor();
      } else if (lost && !app.state.recording) {
        UI.toast('The microphone was unplugged.' + (best ? ' Audabook will use ' + SS.mic.cleanLabel(best.label) + ' for now.' : ''), { kind: 'error' });
        if (app.state.monitoring) await app.reopenMonitor();
      }
    }
    app.refreshMicName(inputs);
  };

  app.microphoneHelp = function () {
    return UI.dialog({
      title: 'Microphone help',
      wide: true,
      content: '<ol class="steps">' +
        '<li><b>Plug it in.</b> Use the USB cable that came with your Maono (a USB-C adapter is fine). Audabook picks a plugged-in mic by itself, and its name shows next to the level meter at the top.</li>' +
        '<li><b>Check the level.</b> Click the level meter (or Tracks → Check My Mic) and sing your loudest part. Mostly green with a little yellow is perfect. ' +
        'If it hits red, turn the <b>gain</b> knob on the mic down; if it barely moves, turn it up.</li>' +
        '<li><b>No sound at all?</b> Most Maono mics have a mute button with a light: red usually means muted. Also check ChromeOS Settings → Security and privacy → Privacy controls → <b>Microphone access</b> is on.</li>' +
        '<li><b>Can’t hear the Chromebook any more after plugging in?</b> ChromeOS may have switched the sound to the mic’s headphone socket. ' +
        'Plug your headphones into the mic, or click the clock in the bottom-right corner, then the arrow next to the volume slider, and pick your speakers or headphones.</li>' +
        '<li><b>Wear headphones</b> while recording over a beat, so the beat doesn’t leak into your vocal.</li>' +
        '</ol>',
      buttons: [{ label: 'Got it', value: true, kind: 'primary' }],
    });
  };

  // ---- tempo (BPM), metronome, bars & beats ----------------------------------------------------

  app.syncTempo = function () {
    app.engine.setMetronome({ on: !!app.settings.metronome, bpm: app.project.bpm, beatsPerBar: app.project.beatsPerBar });
    const input = document.getElementById('bpm');
    if (input && document.activeElement !== input) {
      const v = String(Math.round(app.project.bpm * 100) / 100);
      if (input.value !== v) input.value = v;
    }
    const sig = document.getElementById('time-sig');
    if (sig && sig.value !== String(app.project.beatsPerBar)) sig.value = String(app.project.beatsPerBar);
    const metro = document.querySelector('[data-action=toggleMetronome]');
    if (metro) {
      metro.classList.toggle('active', !!app.settings.metronome);
      metro.setAttribute('aria-pressed', String(!!app.settings.metronome));
    }
  };

  /** Sets the song tempo; turning on the bars-and-beats grid the first time. */
  app.setTempo = function (bpm, live) {
    bpm = Math.round(SS.clamp(SS.finite(bpm, app.project.bpm), M.MIN_BPM, M.MAX_BPM) * 100) / 100;
    if (live) {
      app.beginGesture();
      app.project.bpm = bpm;
      app.project.showBeats = true;
      app.syncTempo();
      app.timeline.invalidate();
      return;
    }
    app.edit('Change tempo', (p) => {
      p.bpm = bpm;
      p.showBeats = true;
    });
    app.syncTempo();
  };

  app.setBeatsPerBar = function (n) {
    app.edit('Change time signature', (p) => {
      p.beatsPerBar = SS.clamp(Math.round(n), 1, 12);
      p.showBeats = true;
    });
  };

  // Tap along to the beat: the tempo is the average gap between the last few taps.
  app.tapTempo = function () {
    const now = root.performance.now();
    const taps = (app.taps = (app.taps || []).filter((t) => now - t < 2500));
    taps.push(now);
    if (taps.length > 8) taps.shift();
    clearTimeout(app.tapTimer);
    app.tapTimer = setTimeout(() => {
      app.taps = [];
      app.endGesture('Tap tempo');
    }, 2500);
    if (taps.length < 2) {
      app.status('Keep tapping along with the beat…');
      return;
    }
    const bpm = Math.round((60000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]));
    app.setTempo(bpm, true);
    app.status('Tempo: ' + app.project.bpm + ' BPM. Keep tapping to fine-tune it.');
  };

  app.toggleMetronome = function () {
    app.settings.metronome = !app.settings.metronome;
    app.saveSettings();
    if (app.settings.metronome && !app.project.showBeats) {
      app.edit('Show bars and beats', (p) => { p.showBeats = true; });
    }
    app.syncTempo();
    app.status(app.settings.metronome
      ? 'Metronome on at ' + app.project.bpm + ' BPM. Recordings start after a one-bar count-in. The click is never in your exports.'
      : 'Metronome off.');
  };

  app.toggleBeats = function () {
    app.edit(app.project.showBeats ? 'Show time' : 'Show bars and beats', (p) => { p.showBeats = !p.showBeats; });
  };

  app.toggleMonitor = async function () {
    const st = app.state;
    if (st.recording || st.starting) return;
    if (st.monitoring) {
      st.monitoring = false;
      app.engine.closeInput();
      app.refreshUI();
      app.status('Mic check off.');
      return;
    }
    try {
      app.engine.ensureContext();
      if (!(await app.micPermissionCheck())) return;
      await app.engine.openInput(app.settings);
      st.monitoring = true;
      app.onDevicesChanged(); // now that the mic is allowed, Chrome shows the mic names
      app.status('Mic check' + (app.engine.input.label ? ' (' + app.engine.input.label + ')' : '') +
        ': sing your loudest part. Mostly green is perfect; if it hits red, turn the mic’s gain knob down.');
    } catch (e) {
      app.handleError(e);
    }
    app.refreshUI();
  };

  // ---- level meter --------------------------------------------------------------------------

  const meter = { value: 0, target: 0, hold: 0, holdAt: 0, clipAt: 0, last: 0, raf: 0, els: [] };

  function meterPos(v) {
    return v <= 0.0005 ? 0 : SS.clamp((20 * Math.log10(v) + 54) / 54, 0, 1);
  }

  function drawMeter() {
    meter.raf = 0;
    const now = root.performance.now();
    const dt = meter.last ? (now - meter.last) / 1000 : 0;
    meter.last = now;
    meter.value = Math.max(meter.target, meter.value * Math.pow(0.02, dt));
    meter.target = 0;
    if (meter.value >= meter.hold || now - meter.holdAt > 1500) {
      meter.hold = meter.value;
      meter.holdAt = now;
    }
    const pos = meterPos(meter.value);
    const holdPos = meterPos(meter.hold);
    const clipping = now - meter.clipAt < 2000;
    for (const m of meter.els) {
      m.cover.style.width = (1 - pos) * 100 + '%';
      m.hold.style.left = 'calc(' + holdPos * 100 + '% - 2px)';
      m.hold.hidden = holdPos <= 0;
      m.root.classList.toggle('clipping', clipping);
    }
    if (app.engine.input || meter.value > 0.0005) meter.raf = requestAnimationFrame(drawMeter);
    else meter.last = 0;
  }

  app.engine.onLevel = function (peak) {
    meter.target = Math.max(meter.target, peak);
    if (peak >= 0.995) meter.clipAt = root.performance.now();
    if (!meter.raf) meter.raf = requestAnimationFrame(drawMeter);
  };

  function buildMeter(rootEl) {
    const m = { root: rootEl, cover: rootEl.querySelector('.meter-cover'), hold: rootEl.querySelector('.meter-hold') };
    meter.els.push(m);
    return m;
  }

  // ---- edit actions -------------------------------------------------------------------------

  app.hint = function () {
    app.status('Drag across a track’s waveform to select some audio first.');
    UI.toast('Select some audio first: drag across a track’s waveform.');
  };

  app.deleteSelection = function (ripple) {
    if (!app.hasRange()) return app.hint();
    const s = app.state.sel;
    const ids = Array.from(s.tracks);
    const t0 = s.t0;
    const len = s.t1 - s.t0;
    app.edit(ripple ? 'Delete and close gap' : 'Delete', (p) => M.deleteRange(p, s.tracks, s.t0, s.t1, ripple));
    app.setSelection(t0, t0, ids);
    app.status('Deleted ' + SS.formatTime(len, 2) + (ripple ? ' and closed the gap' : '') + '. Ctrl+Z puts it back.');
  };

  app.copy = function () {
    if (!app.hasRange()) return app.hint();
    const s = app.state.sel;
    app.clipboard = M.copyRange(app.project, s.tracks, s.t0, s.t1);
    app.status('Copied ' + SS.formatTime(s.t1 - s.t0, 2) + '. Click where it should go, then Paste (Ctrl+V).');
    app.refreshUI();
  };

  app.cut = function () {
    if (!app.hasRange()) return app.hint();
    app.copy();
    app.deleteSelection(false);
    app.status('Cut. Click where it should go, then Paste (Ctrl+V).');
  };

  app.paste = function () {
    const cb = app.clipboard;
    if (!cb) return;
    const s = app.state.sel;
    const t = s.t0;
    const targets = app.selectedTracks().map((x) => x.id);
    const replace = s.t1 - s.t0 > 1e-6 ? [s.t0, s.t1] : null;
    const used = app.edit('Paste', (p) => M.paste(p, targets, t, cb, replace));
    if (used) app.setSelection(t, t + cb.dur, used);
  };

  app.split = function () {
    const s = app.state.sel;
    const ids = s.tracks.size ? s.tracks : new Set(app.project.tracks.map((t) => t.id));
    const points = s.t1 - s.t0 > 1e-6 ? [s.t0, s.t1] : [app.playheadTime()];
    let did = false;
    app.edit('Split', (p) => {
      for (const t of p.tracks) {
        if (!ids.has(t.id)) continue;
        for (const x of points) did = M.splitTrackAt(t, x) || did;
      }
    });
    if (did) app.status('Split. Drag a clip’s top bar to move it, or select part of it and press Backspace to delete.');
    else app.status('To split, click on a clip where you want to cut it, then press Split (S).');
  };

  app.trim = function () {
    if (!app.hasRange()) return app.hint();
    const s = app.state.sel;
    app.edit('Trim', (p) => M.trimToRange(p, s.tracks, s.t0, s.t1));
  };

  // ---- tracks -------------------------------------------------------------------------------

  app.addTrack = function () {
    let id = null;
    app.edit('New track', (p) => {
      const t = M.createTrack(p);
      p.tracks.push(t);
      id = t.id;
    });
    if (!id) return;
    app.selectTrack(id, false);
    const r = app.timeline.rows.get(id);
    if (r) r.row.scrollIntoView({ block: 'nearest' });
  };

  app.deleteTrack = function (id) {
    const t = M.findTrack(app.project, id);
    if (!t || app.state.recording) return;
    app.edit('Delete track', (p) => {
      p.tracks = p.tracks.filter((x) => x.id !== id);
    });
    app.state.sel.tracks.delete(id);
    app.timeline.selectionChanged();
    UI.toast('Deleted “' + t.name + '”.', { action: { label: 'Undo', run: () => app.undo() } });
  };

  app.deleteSelectedTracks = function () {
    const ids = new Set(app.state.sel.tracks);
    if (!ids.size) return;
    const names = app.selectedTracks().map((t) => t.name);
    app.edit(ids.size > 1 ? 'Delete tracks' : 'Delete track', (p) => {
      p.tracks = p.tracks.filter((x) => !ids.has(x.id));
    });
    app.state.sel.tracks = new Set();
    app.timeline.selectionChanged();
    UI.toast('Deleted ' + (names.length > 1 ? names.length + ' tracks' : '“' + names[0] + '”') + '.', {
      action: { label: 'Undo', run: () => app.undo() },
    });
  };

  app.moveTrack = function (dir) {
    const t = app.selectedTracks()[0];
    if (!t) return;
    app.edit(dir < 0 ? 'Move track up' : 'Move track down', (p) => {
      const i = p.tracks.findIndex((x) => x.id === t.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.tracks.length) return;
      const tmp = p.tracks[i];
      p.tracks[i] = p.tracks[j];
      p.tracks[j] = tmp;
    });
  };

  app.renameTrack = function (id, name) {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) {
      app.timeline.refreshHeaders();
      return;
    }
    app.edit('Rename track', (p) => {
      const t = M.findTrack(p, id);
      if (t) t.name = n;
    });
  };

  app.toggleTrackFlag = function (id, flag) {
    let label = '';
    app.edit(flag === 'mute' ? 'Mute' : 'Solo', (p) => {
      const t = M.findTrack(p, id);
      if (!t) return;
      t[flag] = !t[flag];
      label = (t[flag] ? '' : 'Un') + (flag === 'mute' ? 'muted' : 'soloed') + ' “' + t.name + '”';
    }, { mix: true });
    if (label) app.status(label.charAt(0).toUpperCase() + label.slice(1) + '.');
  };

  app.unmuteAll = function () {
    app.edit('Unmute all', (p) => {
      for (const t of p.tracks) {
        t.mute = false;
        t.solo = false;
      }
    }, { mix: true });
  };

  // Slider moves: update the sound immediately; the undo step is made when the slider is released.
  app.setTrackLive = function (id, prop, value) {
    const t = M.findTrack(app.project, id);
    if (!t || t[prop] === value) return;
    app.beginGesture();
    t[prop] = value;
    app.engine.updateMix(app.project);
    const r = app.timeline.rows.get(id);
    if (r) app.timeline.updateHeader(r, t);
  };

  // ---- sources & autosave -------------------------------------------------------------------

  app.addSource = function (buffer, name) {
    const src = makeSource(SS.uid('s'), name, buffer);
    app.sources.set(src.id, src);
    app.persistSource(src);
    return src;
  };

  app.persistSource = function (src) {
    if (!app.store.available) return;
    const p = app.store.putSource(src)
      .catch((e) => app.saveFailed(e))
      .then(() => {
        app.pendingWrites.delete(p);
        app.updateSaveStatus();
      });
    app.pendingWrites.add(p);
    app.updateSaveStatus();
  };

  app.scheduleAutosave = function () {
    app.saveDirty = true;
    clearTimeout(app.saveTimer);
    app.saveTimer = setTimeout(app.autosaveNow, 700);
    app.updateSaveStatus();
  };

  app.autosaveNow = async function () {
    clearTimeout(app.saveTimer);
    if (!app.store.available || !app.saveDirty) return;
    app.saveDirty = false;
    try {
      await Promise.all(Array.from(app.pendingWrites));
      app.pruneSources();
      await app.store.saveProject(JSON.stringify(app.project));
      app.lastSaved = Date.now();
    } catch (e) {
      app.saveDirty = true;
      app.saveFailed(e);
    }
    app.updateSaveStatus();
  };

  app.saveFailed = function (e) {
    console.warn('Autosave failed:', e);
    if (app.saveErrorShown) return;
    app.saveErrorShown = true;
    const full = e && e.name === 'QuotaExceededError';
    UI.toast(full
      ? 'Your Chromebook is out of storage space, so autosave stopped. Free up some space, and use File → Save Project to keep a copy.'
      : 'Autosave ran into a problem. Use File → Save Project to keep a copy of your song.', { kind: 'error', timeout: 15000 });
  };

  // Audio kept alive only so old steps can be undone. Past this, the oldest undo steps are forgotten,
  // so a long session of retakes can't run a 4 GB Chromebook out of memory and crash the tab.
  // navigator.deviceMemory is the RAM in GB, rounded (Chrome reports 4 on a 4 GB Chromebook).
  const deviceGB = SS.finite(root.navigator.deviceMemory, 4);
  const UNDO_AUDIO_BUDGET = (deviceGB <= 4 ? 400 : 800) * 1048576;

  // Forget audio that nothing (the song, undo history, or the clipboard) uses any more.
  app.pruneSources = function () {
    if (app.state.recording) return;
    const inUse = () => {
      const keep = M.referencedSources(app.project);
      for (const id of app.history.referencedSources()) keep.add(id);
      if (app.clipboard) for (const t of app.clipboard.tracks) for (const c of t.clips) keep.add(c.src);
      return keep;
    };
    const bytes = (ids) => {
      let n = 0;
      for (const id of ids) {
        const s = app.sources.get(id);
        if (s) n += s.length * s.channels.length * 4;
      }
      return n;
    };
    let keep = inUse();
    if (bytes(keep) > UNDO_AUDIO_BUDGET) {
      const needed = bytes(M.referencedSources(app.project));
      app.history.redoStack.length = 0;
      while (app.history.undoStack.length && bytes(keep) > Math.max(UNDO_AUDIO_BUDGET, needed)) {
        app.history.undoStack.shift();
        keep = inUse();
      }
      app.refreshUI();
    }
    const drop = [];
    for (const id of app.sources.keys()) if (!keep.has(id)) drop.push(id);
    if (!drop.length) return;
    for (const id of drop) app.sources.delete(id);
    if (app.store.available) app.store.deleteSources(drop).catch((e) => console.warn(e));
  };

  app.updateSaveStatus = function () {
    const s = document.getElementById('save-status');
    if (!s) return;
    let text = '';
    let title = '';
    let cls = '';
    if (!app.store.available) {
      text = 'Not autosaving';
      title = 'This browser is blocking storage. Use File → Save Project to keep your work.';
      cls = 'warn';
    } else if (app.saveDirty || app.pendingWrites.size) {
      text = 'Saving…';
      title = 'Your song is being saved in this browser.';
    } else if (app.lastSaved) {
      text = 'Saved';
      title = 'Your song is saved in this browser and will be here next time.';
      cls = 'ok';
    }
    s.textContent = text;
    s.title = title;
    s.className = 'save-status ' + cls;
  };

  app.restoreAutosave = async function () {
    let rec = null;
    try {
      rec = await app.store.loadProject();
    } catch (e) {
      console.warn(e);
    }
    if (!rec || !rec.json) return;
    let data;
    try {
      data = JSON.parse(rec.json);
    } catch (e) {
      return;
    }
    const project = M.sanitizeProject(data);
    const ids = Array.from(M.referencedSources(project));
    const progress = ids.length ? UI.progress('Opening your song…') : null;
    const map = new Map();
    for (let i = 0; i < ids.length; i++) {
      progress.set(i / ids.length, 'Loading audio ' + (i + 1) + ' of ' + ids.length + '…');
      try {
        const s = await app.store.getSource(ids[i]);
        if (!s || !s.channels || !s.channels.length) continue;
        const buffer = new AudioBuffer({ numberOfChannels: s.channels.length, length: Math.max(1, s.length), sampleRate: s.sampleRate });
        s.channels.forEach((d, c) => buffer.copyToChannel(d, c));
        map.set(ids[i], makeSource(ids[i], s.name || 'Audio', buffer));
      } catch (e) {
        console.warn('Could not restore audio', ids[i], e);
      }
    }
    if (progress) progress.close();
    const dropped = M.dropMissingSources(project, (id) => map.has(id));
    app.project = project;
    app.sources = map;
    app.history.clear();
    app.lastSaved = rec.savedAt || Date.now();
    app.timeline.syncRows();
    app.timeline.zoomFit();
    app.changed();
    if (dropped) UI.toast('Some audio from last time couldn’t be loaded, so ' + SS.plural(dropped, 'clip') + ' had to be removed.', { kind: 'error' });
    try {
      const extra = (await app.store.sourceIds()).filter((id) => !map.has(id));
      await app.store.deleteSources(extra);
    } catch (e) {
      console.warn(e);
    }
    if (project.tracks.length) app.status('Welcome back! “' + project.name + '” is just how you left it.');
  };

  // ---- songs (projects) ---------------------------------------------------------------------

  app.confirmCloseSong = async function (opening) {
    if (!app.project.tracks.length) return true;
    const choice = await UI.dialog({
      title: opening ? 'Open a different song?' : 'Start a new song?',
      content: el('p', {
        text: '“' + app.project.name + '” will be closed. It’s only kept in this browser, so if you want to come back to it later, save it as a project file first.',
      }),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save first…', value: 'save' },
        { label: opening ? 'Close it and open' : 'Start new song', value: 'go', kind: 'danger' },
      ],
    });
    if (choice === 'save') return app.saveProject();
    return choice === 'go';
  };

  app.loadProject = async function (project, sources) {
    app.engine.stopPlayback();
    const st = app.state;
    st.playing = false;
    st.playRange = null;
    st.cursor = 0;
    st.sel = { t0: 0, t1: 0, tracks: new Set() };
    app.project = project;
    app.sources = sources;
    app.history.clear();
    app.clipboard = null;
    app.gesture = null;
    app.saveErrorShown = false;
    if (app.store.available) {
      try {
        await app.store.clear();
      } catch (e) {
        console.warn(e);
      }
      for (const s of sources.values()) app.persistSource(s);
    }
    app.timeline.syncRows();
    app.timeline.zoomFit();
    app.changed();
    app.afterStop();
  };

  app.newProject = async function () {
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    if (!(await app.confirmCloseSong(false))) return;
    await app.loadProject(M.newProject('My Song', app.sampleRate()), new Map());
    app.status('New song started. Import a beat or press Record.');
  };

  app.openProjectPicker = function () {
    const input = document.getElementById('file-project');
    input.value = '';
    input.click();
  };

  app.openProjectFile = async function (file) {
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    if (!(await app.confirmCloseSong(true))) return;
    const progress = UI.progress('Opening “' + file.name + '”…');
    try {
      await UI.nextFrame();
      const data = await SS.readProjectFile(await file.arrayBuffer());
      const map = new Map();
      for (const s of data.sources) map.set(s.id, makeSource(s.id, s.name, s.buffer));
      const dropped = M.dropMissingSources(data.project, (id) => map.has(id));
      progress.close();
      await app.loadProject(data.project, map);
      if (dropped) UI.toast(SS.plural(dropped, 'clip') + ' in that file had no audio and were left out.', { kind: 'error' });
      app.status('Opened “' + data.project.name + '”.');
    } catch (e) {
      progress.close();
      app.handleError(e);
    }
  };

  app.saveProject = async function () {
    if (!app.project.tracks.length) {
      UI.toast('There’s nothing to save yet.');
      return false;
    }
    if (app.state.playing) app.pause();
    const name = SS.safeFileName(app.project.name) + SS.PROJECT_EXT;
    const target = await SS.pickSaveFile(name, {
      id: 'audabook-project', description: 'Audabook project', mime: 'application/x-audabook', ext: SS.PROJECT_EXT,
    });
    if (!target) return false;
    const progress = UI.progress('Saving project…');
    try {
      const blob = await SS.buildProjectFile(app.project, app.sources, (f) => progress.set(f * 0.9, 'Packing up the audio…'));
      progress.set(0.95, 'Writing the file…');
      const where = await target.save(blob);
      progress.close();
      app.status('Project saved to ' + where + '.');
      UI.toast('Saved “' + app.project.name + '” to ' + where + '.', { kind: 'success' });
      return true;
    } catch (e) {
      progress.close();
      app.handleError(e);
      return false;
    }
  };

  app.renameProject = async function () {
    const name = await UI.prompt('Rename song', 'Song name (used to name your exported files)', app.project.name);
    if (name) app.edit('Rename song', (p) => { p.name = name.slice(0, 80); });
  };

  // ---- import -------------------------------------------------------------------------------

  app.importPicker = function () {
    const input = document.getElementById('file-audio');
    input.value = '';
    input.click();
  };

  app.importFiles = async function (fileList) {
    const files = Array.from(fileList || []);
    const proj = files.find((f) => f.name.toLowerCase().endsWith(SS.PROJECT_EXT));
    if (proj) return app.openProjectFile(proj);
    const audio = files.filter((f) => AUDIO_EXT.test(f.name) || /^(audio|video)\//.test(f.type));
    const namedBpm = app.project.showBeats ? null : audio.map((f) => M.parseBpm(f.name)).find((b) => b != null);
    if (!audio.length) {
      if (files.length) UI.toast('Those don’t look like audio files. Try MP3, WAV, M4A, OGG or FLAC.', { kind: 'error' });
      return;
    }
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    const ctx = app.engine.ensureContext();
    const wasEmpty = !app.project.tracks.length;
    const progress = UI.progress(audio.length > 1 ? 'Importing ' + audio.length + ' files…' : 'Importing…');
    app.beginGesture();
    const added = [];
    const failed = [];
    for (let i = 0; i < audio.length; i++) {
      const f = audio[i];
      progress.set(i / audio.length, 'Reading “' + f.name + '”…');
      await UI.nextFrame();
      try {
        const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
        const name = f.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Audio';
        const src = app.addSource(buffer, name);
        const track = M.createTrack(app.project, name);
        track.clips.push({ id: SS.uid('c'), src: src.id, name, offset: 0, start: 0, dur: buffer.duration });
        app.project.tracks.push(track);
        added.push(track.id);
      } catch (e) {
        console.warn('Import failed:', f.name, e);
        failed.push(f.name);
      }
    }
    progress.close();
    if (added.length) {
      if (namedBpm) {
        // Beats are usually named like "Night Drive 140 BPM.mp3", so take the tempo from the name.
        app.project.bpm = namedBpm;
        app.project.showBeats = true;
      }
      app.endGesture(added.length > 1 ? 'Import ' + added.length + ' files' : 'Import audio');
      if (wasEmpty) app.timeline.zoomFit();
      app.setSelection(app.state.cursor, app.state.cursor, added);
      app.status('Imported ' + SS.plural(added.length, 'file') + '. Press Record to sing or play along.');
      if (namedBpm) UI.toast('The file name says ' + namedBpm + ' BPM, so the song tempo is now ' + namedBpm + '. You can change it at the top.', { kind: 'success', timeout: 7000 });
    } else {
      app.gesture = null;
    }
    if (failed.length) {
      UI.toast('Couldn’t open ' + failed.join(', ') + '. Try MP3, WAV, M4A, OGG or FLAC files.', { kind: 'error' });
    }
  };

  // ---- export -------------------------------------------------------------------------------

  function selectBox(options, value) {
    const s = el('select', { class: 'select' }, options.map(([v, label]) => el('option', { value: v, text: label })));
    s.value = String(value);
    if (s.selectedIndex < 0) s.selectedIndex = 0;
    return s;
  }

  function checkBox(label, checked) {
    const input = el('input', { type: 'checkbox', checked: !!checked });
    return { input, label: el('label', { class: 'check' }, [input, el('span', { text: label })]) };
  }

  function radio(name, value, label, checked) {
    const input = el('input', { type: 'radio', name, value, checked: !!checked });
    return { input, label: el('label', { class: 'check' }, [input, el('span', { text: label })]) };
  }

  const field = (label, control) => el('label', { class: 'field' }, [el('span', { text: label }), control]);

  function formatControls() {
    const s = app.settings;
    const bits = selectBox([
      ['16', 'WAV 16-bit (smallest, plays anywhere)'],
      ['24', 'WAV 24-bit (studio quality)'],
      ['32', 'WAV 32-bit float (largest)'],
    ], s.exportBits);
    const native = app.sampleRate();
    const rates = [['44100', '44,100 Hz (CD, most music apps)'], ['48000', '48,000 Hz (video, many studios)']];
    if (native !== 44100 && native !== 48000) rates.push([String(native), native.toLocaleString() + ' Hz (this Chromebook)']);
    const rate = selectBox(rates, s.exportRate || native);
    return { bits, rate };
  }

  app.exportStemsDialog = async function () {
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    const tracks = app.project.tracks.filter((t) => t.clips.length);
    if (!tracks.length) {
      UI.toast('There’s no audio to export yet. Import or record something first.');
      return;
    }
    const s = app.settings;
    const rows = tracks.map((t) => {
      const cb = el('input', { type: 'checkbox', checked: !t.mute });
      const row = el('label', { class: 'stem-row' }, [
        cb,
        el('span', { class: 'stem-swatch', style: 'background:' + t.color }),
        el('span', { class: 'stem-name', text: t.name }),
        el('span', { class: 'stem-meta', text: t.mute ? 'muted' : SS.formatTime(M.trackEnd(t), 1) }),
      ]);
      return { t, cb, row };
    });
    const summary = el('p', { class: 'stem-summary' });
    const fmt = formatControls();
    const applyMix = checkBox('Use each track’s Vol and Pan settings', s.exportApplyMix);
    const includeMix = checkBox('Also export the full mix as one extra file', s.exportIncludeMix);
    const canFolder = SS.FolderTarget.supported();
    const toFolder = radio('saveTo', 'folder', 'WAV files in a new folder (you choose where)', s.exportTo !== 'zip');
    const toZip = radio('saveTo', 'zip', 'One .zip file in Downloads (easy to send to someone)', s.exportTo === 'zip');
    const content = el('div', { class: 'export-form' }, [
      el('p', { class: 'dlg-lead', text: 'Each ticked track becomes its own WAV file. Every stem starts at 0:00 and is exactly the same length, so they line up perfectly in any music app.' }),
      el('div', { class: 'stem-list' }, rows.map((r) => r.row)),
      summary,
      el('div', { class: 'form-grid' }, [field('Format', fmt.bits), field('Sample rate', fmt.rate)]),
      applyMix.label,
      includeMix.label,
      canFolder ? el('fieldset', { class: 'radio-group' }, [el('legend', { text: 'Save as' }), toFolder.label, toZip.label]) : null,
    ]);
    let ctrl = null;
    const chosen = () => rows.filter((r) => r.cb.checked).map((r) => r.t);
    const update = () => {
      const list = chosen();
      const end = list.reduce((m, t) => Math.max(m, M.trackEnd(t)), 0);
      summary.textContent = list.length
        ? SS.plural(list.length, 'stem') + ', each exactly ' + SS.formatTime(end, 3) + ' long.'
        : 'Tick at least one track to export.';
      if (ctrl) {
        ctrl.buttons.go.disabled = !list.length;
        ctrl.buttons.go.textContent = list.length ? 'Export ' + SS.plural(list.length, 'Stem') : 'Export';
      }
    };
    rows.forEach((r) => r.cb.addEventListener('change', update));
    const result = await UI.dialog({
      title: 'Export All Stems',
      content,
      wide: true,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Export', value: 'go', kind: 'primary', id: 'go' },
      ],
      onOpen(c) {
        ctrl = c;
        update();
      },
    });
    const list = chosen();
    if (result !== 'go' || !list.length) return;
    const opt = {
      bits: +fmt.bits.value,
      rate: +fmt.rate.value,
      applyMix: applyMix.input.checked,
      includeMix: includeMix.input.checked,
      toFolder: canFolder && !toZip.input.checked,
    };
    Object.assign(app.settings, {
      exportBits: opt.bits, exportRate: opt.rate, exportApplyMix: opt.applyMix,
      exportIncludeMix: opt.includeMix, exportTo: opt.toFolder ? 'folder' : 'zip',
    });
    app.saveSettings();
    await app.exportStems(list, opt);
  };

  /** opt: { bits, rate, applyMix, includeMix, toFolder } */
  app.exportStems = async function (tracks, opt) {
    // Stem packs usually carry the tempo in the name, which saves whoever gets them a question.
    const base = SS.safeFileName(app.project.name + (app.project.showBeats ? ' ' + app.project.bpm + ' BPM' : ''));
    let target = null;
    if (opt.toFolder) {
      try {
        target = await SS.FolderTarget.create(base + ' stems');
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.warn(e);
        UI.toast('Chrome couldn’t save into that folder, so your stems will download as a .zip file instead.');
      }
    }
    if (!target) target = new SS.ZipTarget(base + ' stems.zip', base + ' stems');
    const end = tracks.reduce((m, t) => Math.max(m, M.trackEnd(t)), 0);
    const frames = M.stemFrames(end, opt.rate);
    const jobs = tracks.map((t, i) => ({
      tracks: [t],
      file: String(i + 1).padStart(2, '0') + ' ' + SS.safeFileName(t.name) + '.wav',
      label: t.name,
      text: 'Stem ' + (i + 1) + ' of ' + tracks.length + ': ' + t.name,
    }));
    if (opt.includeMix) jobs.push({ tracks, file: '00 ' + base + ' (full mix).wav', label: 'the full mix', text: 'Mixing the full song…' });
    const progress = UI.progress('Exporting stems…');
    const loud = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        progress.set(i / jobs.length, job.text);
        await UI.nextFrame();
        const buf = await SS.renderTracks(job.tracks, app.sources, { sampleRate: opt.rate, frames, applyMix: opt.applyMix });
        if (opt.bits !== 32 && SS.audiblyClips(buf)) loud.push(job.label);
        await target.add(job.file, SS.encodeWav(SS.channelsOf(buf), opt.rate, opt.bits));
      }
      progress.set(1, 'Finishing…');
      const where = await target.finish();
      progress.close();
      app.lastExport = { files: jobs.map((j) => j.file), frames, rate: opt.rate, bits: opt.bits, where };
      app.status('Exported ' + SS.plural(jobs.length, 'stem') + ' to ' + where + '.');
      UI.dialog({
        title: 'Stems exported',
        content: el('div', null, [
          el('p', { text: 'Saved ' + SS.plural(jobs.length, 'WAV file') + ' to ' + where + '.' }),
          el('p', { text: 'Each one is exactly ' + SS.formatTime(end, 3) + ' long and starts at 0:00, so they line up when you drop them into another app.' }),
          loud.length ? el('p', { class: 'warn', text: 'Heads up: ' + loud.join(', ') + (loud.length > 1 ? ' were' : ' was') + ' too loud for a WAV file, so the loudest moments got clipped (they may sound crunchy). Turn the Vol slider down a little on ' + (loud.length > 1 ? 'those tracks' : 'that track') + ' and export again.' }) : null,
        ]),
        buttons: [{ label: 'Done', value: true, kind: 'primary' }],
      });
    } catch (e) {
      progress.close();
      app.handleError(e);
    }
  };

  app.exportMixDialog = async function () {
    if (app.state.recording) return;
    if (app.state.playing) app.pause();
    const tracks = app.project.tracks.filter((t) => t.clips.length && M.isAudible(app.project, t));
    if (!tracks.length) {
      UI.toast(app.project.tracks.some((t) => t.clips.length)
        ? 'Every track with audio is muted, so the mix would be silent.'
        : 'There’s no audio to export yet. Import or record something first.');
      return;
    }
    const fmt = formatControls();
    const result = await UI.dialog({
      title: 'Export Mix as WAV',
      content: el('div', { class: 'export-form' }, [
        el('p', { class: 'dlg-lead', text: 'Saves the whole song as one stereo WAV file: exactly what you hear, so muted tracks are left out.' }),
        el('div', { class: 'form-grid' }, [field('Format', fmt.bits), field('Sample rate', fmt.rate)]),
      ]),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Export Mix', value: 'go', kind: 'primary' },
      ],
    });
    if (result !== 'go') return;
    const bits = +fmt.bits.value;
    const rate = +fmt.rate.value;
    Object.assign(app.settings, { exportBits: bits, exportRate: rate });
    app.saveSettings();
    const name = SS.safeFileName(app.project.name) + '.wav';
    const target = await SS.pickSaveFile(name, { id: 'audabook-mix', description: 'WAV audio', mime: 'audio/wav', ext: '.wav' });
    if (!target) return;
    const progress = UI.progress('Exporting the mix…');
    try {
      await UI.nextFrame();
      const end = tracks.reduce((m, t) => Math.max(m, M.trackEnd(t)), 0);
      const buf = await SS.renderTracks(tracks, app.sources, { sampleRate: rate, frames: M.stemFrames(end, rate), applyMix: true });
      const clipped = bits !== 32 && SS.audiblyClips(buf);
      const where = await target.save(new Blob([SS.encodeWav(SS.channelsOf(buf), rate, bits)], { type: 'audio/wav' }));
      progress.close();
      app.status('Exported the mix to ' + where + '.');
      UI.toast('Saved the mix to ' + where + '.' + (clipped ? ' It was a little too loud in places; turn some tracks down to avoid crunchy peaks.' : ''), {
        kind: clipped ? 'error' : 'success', timeout: clipped ? 12000 : 6000,
      });
    } catch (e) {
      progress.close();
      app.handleError(e);
    }
  };

  // ---- settings & help ----------------------------------------------------------------------

  app.applyTheme = function () {
    const t = app.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    if (app.timeline) app.timeline.readTheme();
  };

  app.settingsDialog = async function () {
    const s = app.settings;
    const mic = el('select', { class: 'select' }, [el('option', { value: '', text: 'Automatic (uses your USB mic when it’s plugged in)' })]);
    const using = el('p', { class: 'dim mic-using' });
    const fillDevices = async () => {
      const inputs = await SS.mic.listInputs();
      while (mic.options.length > 1) mic.remove(1);
      inputs.forEach((d, n) => mic.appendChild(el('option', { value: d.deviceId, text: d.label ? SS.mic.cleanLabel(d.label) : 'Microphone ' + (n + 1) })));
      mic.value = s.deviceId;
      if (mic.value !== s.deviceId) mic.value = '';
      await app.refreshMicName(inputs);
      using.textContent = app.micName
        ? 'Now using: ' + app.micName
        : 'Mic names show up after you press Record or “Check my mic” once and allow the microphone.';
    };
    fillDevices();
    const meterEl = el('div', { class: 'meter big', title: 'Microphone level' }, [
      el('div', { class: 'meter-cover' }), el('div', { class: 'meter-hold', hidden: true }),
    ]);
    const m = buildMeter(meterEl);
    const test = el('button', { class: 'btn', type: 'button' });
    const setTestLabel = () => (test.textContent = app.state.monitoring ? 'Stop mic check' : 'Check my mic');
    setTestLabel();
    test.addEventListener('click', async () => {
      await app.toggleMonitor();
      setTestLabel();
      fillDevices(); // device names appear once the mic is allowed
    });
    const restartMic = async () => {
      app.saveSettings();
      if (app.state.monitoring) {
        app.engine.closeInput();
        app.state.monitoring = false;
        await app.toggleMonitor();
        setTestLabel();
      }
    };
    mic.addEventListener('change', async () => {
      s.deviceId = mic.value;
      await restartMic();
      fillDevices();
    });
    const mono = radio('channels', 'mono', 'Mono (best for one mic: voice, guitar)', !s.stereo);
    const stereo = radio('channels', 'stereo', 'Stereo (two-input audio interfaces)', s.stereo);
    const onChannels = () => {
      s.stereo = stereo.input.checked;
      restartMic();
    };
    mono.input.addEventListener('change', onChannels);
    stereo.input.addEventListener('change', onChannels);
    const music = checkBox('Music mode: turn off Chrome’s voice-call filters (recommended, use headphones)', s.musicMode);
    music.input.addEventListener('change', () => {
      s.musicMode = music.input.checked;
      restartMic();
    });
    const autoLevel = checkBox('Turn quiet recordings up automatically', s.autoLevel !== false);
    autoLevel.input.addEventListener('change', () => {
      s.autoLevel = autoLevel.input.checked;
      app.saveSettings();
    });
    const latOut = el('output', { class: 'range-val' });
    const lat = el('input', { type: 'range', min: '-300', max: '300', step: '5', value: String(s.latencyMs), class: 'range' });
    const showLat = () => (latOut.textContent = (s.latencyMs > 0 ? '+' : '') + s.latencyMs + ' ms');
    showLat();
    lat.addEventListener('input', () => {
      s.latencyMs = +lat.value;
      showLat();
      app.saveSettings();
    });
    const theme = selectBox([['auto', 'Match my Chromebook'], ['light', 'Light'], ['dark', 'Dark']], s.theme);
    theme.addEventListener('change', () => {
      s.theme = theme.value;
      app.saveSettings();
      app.applyTheme();
    });
    const content = el('div', { class: 'settings-form' }, [
      el('h3', { text: 'Microphone' }),
      field('Record from', mic),
      using,
      el('div', { class: 'meter-row' }, [meterEl, test]),
      el('div', { class: 'radio-group plain' }, [mono.label, stereo.label]),
      music.label,
      autoLevel.label,
      el('h3', { text: 'Timing' }),
      el('label', { class: 'field' }, [
        el('span', { text: 'Recording timing fix' }),
        el('div', { class: 'range-row' }, [lat, latOut]),
      ]),
      el('p', { class: 'dim', text: 'If your recordings sound a little late against the beat, slide this to the right (try +40 ms, then listen). If they sound early, slide it left. Bluetooth headphones usually need a lot more; wired ones are best for recording.' }),
      el('h3', { text: 'Look' }),
      field('Theme', theme),
    ]);
    await UI.dialog({
      title: 'Settings',
      content,
      wide: true,
      buttons: [{ label: 'Done', value: true, kind: 'primary' }],
      onClose() {
        meter.els.splice(meter.els.indexOf(m), 1);
      },
    });
    app.saveSettings();
  };

  app.quickStart = function () {
    storageFlag(SEEN_KEY, true);
    return UI.dialog({
      title: 'Welcome to Audabook',
      wide: true,
      content:
        '<ol class="steps">' +
        '<li><b>Bring in a beat or song.</b> Use <b>Import</b> (or File → Import Audio), or drag a file onto this window. ' +
        'Type its tempo in the <b>BPM</b> box at the top (or tap <b>Tap</b> along with the beat) to get bars and beats and a metronome.</li>' +
        '<li><b>Record.</b> Plug in your mic (your Maono is picked automatically) and put on headphones. Press ' +
        '<span class="kbd rec">●</span> Record (or the <span class="kbd">R</span> key), and <span class="kbd">Space</span> to stop. ' +
        'Every take goes on its own track.</li>' +
        '<li><b>Trim and cut.</b> Drag across a waveform to select part of it, then press <span class="kbd">Backspace</span> to delete it. ' +
        '<b>Split</b> (<span class="kbd">S</span>) cuts a clip in two at the cursor. Drag a clip’s colored top bar to move it, or drag its edge to trim it.</li>' +
        '<li><b>Export.</b> File → Export → <b>Export All Stems</b> (or the big <b>Export Stems</b> button) saves every track as its own WAV file, all exactly the same length.</li>' +
        '</ol>' +
        '<p class="dim">Your song saves itself in this browser as you go. Made a mistake? <span class="kbd">Ctrl</span>+<span class="kbd">Z</span> undoes anything.</p>',
      buttons: [{ label: 'Let’s go', value: true, kind: 'primary' }],
    });
  };

  app.shortcutsDialog = function () {
    const rows = [
      ['Space', 'Play / pause (stops recording too)'],
      ['R', 'Record on a new track'],
      ['Shift + R', 'Record into the selected track'],
      ['Backspace', 'Delete the selected audio (leaves a gap)'],
      ['Ctrl + Backspace', 'Delete and close the gap'],
      ['S', 'Split clips at the cursor'],
      ['K', 'Metronome on / off'],
      ['T', 'Tap tempo (tap along with the beat)'],
      ['Ctrl + Z / Ctrl + Y', 'Undo / redo'],
      ['Ctrl + X / C / V', 'Cut / copy / paste'],
      ['Ctrl + A', 'Select everything'],
      ['Esc', 'Select nothing'],
      ['← →', 'Move the cursor 1 second (Shift: 5 seconds)'],
      ['Search + ← / →', 'Go to start / end (Home / End)'],
      ['+  /  -  /  F', 'Zoom in / out / fit the whole song'],
      ['Ctrl + scroll or pinch', 'Zoom around the pointer'],
      ['Shift + scroll', 'Scroll sideways'],
      ['Ctrl + I', 'Import audio'],
      ['Ctrl + Shift + E', 'Export all stems'],
      ['Ctrl + S / Ctrl + O', 'Save / open a project file'],
    ];
    return UI.dialog({
      title: 'Keyboard shortcuts',
      wide: true,
      content: el('table', { class: 'shortcuts' }, rows.map(([k, d]) => el('tr', null, [el('td', null, [el('span', { class: 'kbd', text: k })]), el('td', { text: d })]))),
      buttons: [{ label: 'Close', value: true, kind: 'primary' }],
    });
  };

  app.aboutDialog = function () {
    return UI.dialog({
      title: 'About Audabook',
      content:
        '<p><b>Audabook ' + SS.VERSION + '</b>: a simple multitrack recorder for Chromebooks. Record, trim, and export stems ' +
        'without installing Linux.</p>' +
        '<p class="dim">The layout and shortcuts follow Audacity, so tutorials for it mostly apply. This is an independent ' +
        'project, not made by or affiliated with the Audacity team. Some icons are adapted from Google’s Material Icons ' +
        '(Apache License 2.0).</p>',
      buttons: [{ label: 'Close', value: true, kind: 'primary' }],
    });
  };

  // ---- actions, menus, toolbar -------------------------------------------------------------

  const idle = () => !app.state.recording && !app.state.starting;
  const hasAudio = () => app.project.tracks.some((t) => t.clips.length);

  const ACTIONS = {
    newProject: { run: () => app.newProject(), when: idle },
    openProject: { run: () => app.openProjectPicker(), when: idle },
    saveProject: { run: () => app.saveProject(), when: () => idle() && app.project.tracks.length > 0 },
    renameProject: { run: () => app.renameProject(), when: idle },
    importAudio: { run: () => app.importPicker(), when: idle },
    exportStems: { run: () => app.exportStemsDialog(), when: () => idle() && hasAudio() },
    exportMix: { run: () => app.exportMixDialog(), when: () => idle() && hasAudio() },
    undo: { run: () => app.undo(), when: () => idle() && app.history.canUndo() },
    redo: { run: () => app.redo(), when: () => idle() && app.history.canRedo() },
    cut: { run: () => app.cut(), when: () => idle() && app.hasRange(), else: () => app.hint() },
    copy: { run: () => app.copy(), when: () => idle() && app.hasRange(), else: () => app.hint() },
    paste: { run: () => app.paste(), when: () => idle() && !!app.clipboard },
    delete: { run: () => app.deleteSelection(false), when: () => idle() && app.hasRange(), else: () => idle() && app.hint() },
    deleteGap: { run: () => app.deleteSelection(true), when: () => idle() && app.hasRange(), else: () => idle() && app.hint() },
    split: { run: () => app.split(), when: () => idle() && hasAudio() },
    trim: { run: () => app.trim(), when: () => idle() && app.hasRange(), else: () => idle() && app.hint() },
    selectAll: { run: () => app.selectAll(), when: () => idle() && app.project.tracks.length > 0 },
    selectNone: { run: () => app.selectNone(), when: idle },
    togglePlay: { run: () => app.togglePlay(), when: () => !app.state.starting },
    stop: { run: () => app.stop(), when: () => app.state.playing },
    record: { run: () => app.record(false), when: () => !app.state.starting },
    recordInto: { run: () => app.record(true), when: () => idle() && app.selectedTracks().length > 0 },
    recordMenu: { run: (btn) => app.openRecordMenu(btn), when: idle },
    toggleMonitor: { run: () => app.toggleMonitor(), when: idle },
    goStart: { run: () => app.goStart(), when: idle },
    goEnd: { run: () => app.goEnd(), when: idle },
    addTrack: { run: () => app.addTrack(), when: idle },
    deleteTracks: { run: () => app.deleteSelectedTracks(), when: () => idle() && app.state.sel.tracks.size > 0 },
    moveTrackUp: { run: () => app.moveTrack(-1), when: () => idle() && app.state.sel.tracks.size > 0 },
    moveTrackDown: { run: () => app.moveTrack(1), when: () => idle() && app.state.sel.tracks.size > 0 },
    unmuteAll: { run: () => app.unmuteAll(), when: () => idle() && app.project.tracks.some((t) => t.mute || t.solo) },
    toggleMetronome: { run: () => app.toggleMetronome() },
    toggleBeats: { run: () => app.toggleBeats(), when: idle },
    tapTempo: { run: () => app.tapTempo(), when: idle },
    micHelp: { run: () => app.microphoneHelp() },
    zoomIn: { run: () => app.timeline.zoomBy(2) },
    zoomOut: { run: () => app.timeline.zoomBy(0.5) },
    zoomFit: { run: () => app.timeline.zoomFit() },
    settings: { run: () => app.settingsDialog(), when: idle },
    quickStart: { run: () => app.quickStart() },
    shortcuts: { run: () => app.shortcutsDialog() },
    about: { run: () => app.aboutDialog() },
  };

  app.canRun = function (name) {
    const a = ACTIONS[name];
    return !!a && (!a.when || !!a.when());
  };

  app.run = function (name, arg) {
    const a = ACTIONS[name];
    if (!a) return;
    if (a.when && !a.when()) {
      if (a.else) a.else();
      return;
    }
    try {
      const r = a.run(arg);
      if (r && typeof r.catch === 'function') r.catch(app.handleError);
    } catch (e) {
      app.handleError(e);
    }
  };

  const MENUS = [
    {
      label: 'File',
      items: [
        { label: 'New Song', action: 'newProject' },
        { label: 'Open Project…', action: 'openProject', shortcut: 'Ctrl+O' },
        { label: 'Save Project…', action: 'saveProject', shortcut: 'Ctrl+S' },
        { label: 'Rename Song…', action: 'renameProject' },
        { sep: true },
        { label: 'Import Audio…', action: 'importAudio', shortcut: 'Ctrl+I' },
        {
          label: 'Export',
          submenu: [
            { label: 'Export All Stems…', action: 'exportStems', shortcut: 'Ctrl+Shift+E' },
            { label: 'Export Mix as WAV…', action: 'exportMix', shortcut: 'Ctrl+E' },
          ],
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: () => 'Undo ' + app.history.undoLabel(), action: 'undo', shortcut: 'Ctrl+Z' },
        { label: () => 'Redo ' + app.history.redoLabel(), action: 'redo', shortcut: 'Ctrl+Y' },
        { sep: true },
        { label: 'Cut', action: 'cut', shortcut: 'Ctrl+X' },
        { label: 'Copy', action: 'copy', shortcut: 'Ctrl+C' },
        { label: 'Paste', action: 'paste', shortcut: 'Ctrl+V' },
        { label: 'Delete', action: 'delete', shortcut: 'Backspace' },
        { label: 'Delete and Close Gap', action: 'deleteGap', shortcut: 'Ctrl+Backspace' },
        { sep: true },
        { label: 'Split at Cursor', action: 'split', shortcut: 'S' },
        { label: 'Trim to Selection', action: 'trim' },
        { sep: true },
        { label: 'Select All', action: 'selectAll', shortcut: 'Ctrl+A' },
        { label: 'Select None', action: 'selectNone', shortcut: 'Esc' },
        { sep: true },
        { label: 'Settings…', action: 'settings' },
      ],
    },
    {
      label: 'Tracks',
      items: [
        { label: 'Record on New Track', action: 'record', shortcut: 'R' },
        { label: 'Record into Selected Track', action: 'recordInto', shortcut: 'Shift+R' },
        { label: 'Check My Mic', action: 'toggleMonitor' },
        { sep: true },
        { label: 'New Empty Track', action: 'addTrack' },
        { label: 'Delete Selected Track', action: 'deleteTracks' },
        { label: 'Move Track Up', action: 'moveTrackUp' },
        { label: 'Move Track Down', action: 'moveTrackDown' },
        { sep: true },
        { label: 'Unmute and Unsolo All', action: 'unmuteAll' },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', action: 'zoomIn', shortcut: '+' },
        { label: 'Zoom Out', action: 'zoomOut', shortcut: '-' },
        { label: 'Fit Whole Song', action: 'zoomFit', shortcut: 'F' },
        { sep: true },
        { label: () => (app.project.showBeats ? 'Show Minutes and Seconds' : 'Show Bars and Beats'), action: 'toggleBeats' },
        { label: () => (app.settings.metronome ? 'Turn Metronome Off' : 'Turn Metronome On'), action: 'toggleMetronome', shortcut: 'K' },
        { label: 'Tap Tempo', action: 'tapTempo', shortcut: 'T' },
        { sep: true },
        { label: 'Go to Start', action: 'goStart', shortcut: 'Home' },
        { label: 'Go to End', action: 'goEnd', shortcut: 'End' },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Quick Start', action: 'quickStart' },
        { label: 'Microphone Help', action: 'micHelp' },
        { label: 'Keyboard Shortcuts', action: 'shortcuts' },
        { label: 'About Audabook', action: 'about' },
      ],
    },
  ];

  app.openRecordMenu = function (btn) {
    const r = btn.getBoundingClientRect();
    if (app.popup.isOpen && app.popup.owner === btn) {
      app.popup.close();
      return;
    }
    app.popup.open([
      { label: 'Record on a new track', action: 'record', shortcut: 'R' },
      { label: 'Record into the selected track', action: 'recordInto', shortcut: 'Shift+R' },
      { sep: true },
      { label: 'Check my mic', action: 'toggleMonitor' },
      { label: () => (app.settings.metronome ? 'Metronome and count-in: on' : 'Metronome and count-in: off'), action: 'toggleMetronome', shortcut: 'K' },
      { label: 'Microphone settings…', action: 'settings' },
      { label: 'Microphone help', action: 'micHelp' },
    ], r.left, r.bottom + 4, btn);
  };

  app.refreshUI = function () {
    const st = app.state;
    const body = document.body;
    body.classList.toggle('is-playing', st.playing && !st.recording);
    body.classList.toggle('is-recording', !!st.recording);
    body.classList.toggle('is-monitoring', st.monitoring);
    for (const b of document.querySelectorAll('#toolbar [data-action], #empty [data-action], .ruler-corner [data-action]')) {
      b.disabled = !app.canRun(b.dataset.action);
    }
    const play = document.querySelector('[data-action=togglePlay]');
    const showPause = st.playing && !st.recording;
    if (play.dataset.icon !== (showPause ? 'pause' : 'play')) {
      play.dataset.icon = showPause ? 'pause' : 'play';
      play.replaceChild(UI.icon(play.dataset.icon, 22), play.firstChild);
    }
    play.title = showPause ? 'Pause (Space)' : 'Play (Space)';
    const rec = document.querySelector('[data-action=record]');
    rec.classList.toggle('active', !!st.recording);
    rec.title = st.recording ? 'Stop recording (Space)' : 'Record on a new track (R)';
    const nameBtn = document.getElementById('project-name');
    if (nameBtn.textContent !== app.project.name) nameBtn.textContent = app.project.name;
    document.title = app.project.name + ' – Audabook';
    app.updateSaveStatus();
    app.updateTime();
  };

  app.updateTime = function (pos) {
    const t = pos != null ? pos : app.playheadTime();
    const main = document.getElementById('time-main');
    const sub = document.getElementById('time-sub');
    const text = SS.formatTime(t, 3);
    if (main.textContent !== text) main.textContent = text;
    const s = app.state.sel;
    let subText;
    const rec = app.state.recording;
    if (rec && app.engine.ctx && app.engine.ctx.currentTime < rec.playStart) {
      const left = Math.ceil((rec.playStart - app.engine.ctx.currentTime) / (60 / app.project.bpm));
      subText = 'Count-in… ' + left;
    } else if (rec) subText = 'Recording ' + SS.formatTime(app.liveEnd() - rec.from, 1);
    else if (s.t1 - s.t0 > 1e-6) subText = 'Selected ' + SS.formatTime(s.t1 - s.t0, 2);
    else subText = 'Song length ' + SS.formatTime(M.projectEnd(app.project), 0);
    if (sub.textContent !== subText) sub.textContent = subText;
  };

  app.status = function (msg) {
    const s = document.getElementById('status');
    if (s) s.textContent = msg;
  };

  app.handleError = function (e) {
    if (!e || e.name === 'AbortError') return;
    console.error(e);
    UI.toast(e instanceof SS.UserError ? e.message : 'Something went wrong: ' + (e.message || String(e)), { kind: 'error' });
  };

  // ---- wiring -------------------------------------------------------------------------------

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit)$/i.test(t.type);
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || isTyping(e.target)) return;
    if (document.querySelector('dialog[open]') || app.menubar.menu.isOpen || app.popup.isOpen) return;
    const onSlider = e.target.tagName === 'INPUT' && e.target.type === 'range';
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const run = (name) => {
      e.preventDefault();
      app.run(name);
    };
    if (k === ' ' || k === 'Spacebar') return run('togglePlay');
    if (ctrl) {
      switch (k.toLowerCase()) {
        case 'z': return run(e.shiftKey ? 'redo' : 'undo');
        case 'y': return run('redo');
        case 'x': return run('cut');
        case 'c': return run('copy');
        case 'v': return run('paste');
        case 'a': return run('selectAll');
        case 's': return run('saveProject');
        case 'o': return run('openProject');
        case 'i': return run('importAudio');
        case 'e': return run(e.shiftKey ? 'exportStems' : 'exportMix');
        case 'backspace':
        case 'delete': return run('deleteGap');
      }
      return;
    }
    if (e.altKey) return;
    if (onSlider && /^(Arrow|Home|End|Page)/.test(k)) return;
    switch (k) {
      case 'Delete':
      case 'Backspace': return run('delete');
      case 'r':
      case 'R': return run(e.shiftKey ? 'recordInto' : 'record');
      case 's':
      case 'S': return run('split');
      case 'k':
      case 'K': return run('toggleMetronome');
      case 't':
      case 'T': return run('tapTempo');
      case 'Home': return run('goStart');
      case 'End': return run('goEnd');
      case 'ArrowLeft':
        e.preventDefault();
        return app.nudge(e.shiftKey ? -5 : -1);
      case 'ArrowRight':
        e.preventDefault();
        return app.nudge(e.shiftKey ? 5 : 1);
      case '=':
      case '+': return run('zoomIn');
      case '-':
      case '_': return run('zoomOut');
      case 'f':
      case 'F': return run('zoomFit');
      case 'Escape': return run('selectNone');
    }
  }

  function bindToolbar() {
    for (const b of document.querySelectorAll('[data-action]')) {
      if (b.dataset.icon) b.insertBefore(UI.icon(b.dataset.icon, b.dataset.size ? +b.dataset.size : 20), b.firstChild);
      b.addEventListener('click', () => {
        app.run(b.dataset.action, b);
        if (b.dataset.action !== 'recordMenu') b.blur();
      });
    }
    document.getElementById('project-name').addEventListener('click', () => app.run('renameProject'));
    buildMeter(document.getElementById('meter'));
    const chip = document.getElementById('meter-btn');
    chip.addEventListener('click', () => {
      app.run('toggleMonitor');
      chip.blur();
    });
    const bpm = document.getElementById('bpm');
    bpm.addEventListener('change', () => {
      if (bpm.value !== '' && isFinite(+bpm.value)) app.setTempo(+bpm.value);
      else app.syncTempo();
    });
    bpm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        if (e.key === 'Escape') bpm.value = String(app.project.bpm);
        bpm.blur();
      }
    });
    bpm.addEventListener('blur', () => app.syncTempo());
    const sig = document.getElementById('time-sig');
    sig.addEventListener('change', () => {
      app.setBeatsPerBar(+sig.value);
      sig.blur();
    });
    document.getElementById('file-audio').addEventListener('change', (e) => app.importFiles(e.target.files));
    document.getElementById('file-project').addEventListener('change', (e) => {
      if (e.target.files[0]) app.openProjectFile(e.target.files[0]);
    });
  }

  function bindDragDrop() {
    const hint = document.getElementById('drop-hint');
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    let depth = 0;
    root.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      hint.hidden = false;
    });
    root.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hint.hidden = true;
    });
    root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      hint.hidden = true;
      app.importFiles(e.dataTransfer.files);
    });
  }

  app.init = async function () {
    app.applyTheme();
    app.timeline = new SS.Timeline(app);
    app.timeline.pps = app.timeline.laneWidth / 40;
    app.menubar = new UI.MenuBar(document.getElementById('menus'), MENUS, app);
    app.popup = new UI.Menu(app);
    bindToolbar();
    bindDragDrop();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', (e) => {
      if ((e.key === ' ' || e.key === 'Spacebar') && !isTyping(e.target) && !document.querySelector('dialog[open]')) e.preventDefault();
    }, true);
    if (root.matchMedia) {
      const mq = root.matchMedia('(prefers-color-scheme: dark)');
      const onScheme = () => app.timeline.readTheme();
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    root.addEventListener('error', (e) => {
      if (e.message && /ResizeObserver/.test(e.message)) return;
      app.handleError(e.error || new Error(e.message));
    });
    root.addEventListener('unhandledrejection', (e) => app.handleError(e.reason));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') app.autosaveNow();
    });
    root.addEventListener('beforeunload', (e) => {
      if (app.state.recording || app.pendingWrites.size || (app.saveDirty && app.store.available)) {
        app.autosaveNow();
        e.preventDefault();
        e.returnValue = '';
      }
    });
    app.changed();
    app.saveDirty = false;
    app.status('Ready');

    if (await app.store.open()) {
      await app.restoreAutosave();
      if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist().catch(() => {});
    }
    app.updateSaveStatus();
    app.refreshUI();

    const md = root.navigator.mediaDevices;
    if (md && md.addEventListener) {
      let timer = 0;
      md.addEventListener('devicechange', () => {
        clearTimeout(timer);
        timer = setTimeout(() => app.onDevicesChanged(), 400); // devices arrive in bursts
      });
    }
    app.onDevicesChanged();

    if (root.launchQueue && root.launchQueue.setConsumer) {
      root.launchQueue.setConsumer(async (params) => {
        if (!params.files || !params.files.length) return;
        const files = await Promise.all(params.files.map((h) => h.getFile()));
        app.importFiles(files);
      });
    }
    if ('serviceWorker' in root.navigator && root.location.protocol === 'https:') {
      root.navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline mode unavailable:', e));
    }
    if (!storageFlag(SEEN_KEY)) app.quickStart();
  };

  app.init().catch((e) => app.handleError(e));
})(window);
