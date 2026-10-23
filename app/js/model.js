/* Audabook — the song (project) model and every editing operation on it.
   Editing is non-destructive: a clip is a window into a piece of recorded/imported audio (a "source"),
   so cutting and trimming never copy audio. Clips on one track never overlap. All times are seconds. */
(function (root) {
  'use strict';
  const SS = (root.SS = root.SS || {});
  const M = (SS.model = {});

  const EPS = 1e-6; // anything shorter than this is treated as nothing
  M.EPS = EPS;

  M.TRACK_COLORS = ['#4f7cff', '#ef5d5d', '#2fb67c', '#f0a030', '#a46bf0', '#22b5c9', '#e85ba5', '#8f9f3a'];

  M.MIN_BPM = 30;
  M.MAX_BPM = 300;

  // showBeats turns on the bars-and-beats ruler, grid, and snapping once the tempo has been set.
  M.newProject = function (name, sampleRate) {
    return {
      version: 1,
      name: name || 'My Song',
      sampleRate: sampleRate || 48000,
      bpm: 120,
      beatsPerBar: 4,
      showBeats: false,
      tracks: [],
    };
  };

  /** "Dark Trap Beat 140 BPM.mp3" -> 140. Null if the name has no believable tempo in it. */
  M.parseBpm = function (fileName) {
    const s = String(fileName || '');
    const m = /(\d{2,3}(?:\.\d+)?)\s*-?_?\s*bpm/i.exec(s) || /bpm\s*[-_:]?\s*(\d{2,3}(?:\.\d+)?)/i.exec(s);
    if (!m) return null;
    const bpm = +m[1];
    return bpm >= 50 && bpm <= 220 ? Math.round(bpm * 100) / 100 : null;
  };

  // The least-used colour, so new tracks stay easy to tell apart.
  M.pickColor = function (project) {
    const uses = M.TRACK_COLORS.map((c) => project.tracks.filter((t) => t.color === c).length);
    const fewest = Math.min.apply(null, uses);
    return M.TRACK_COLORS[uses.indexOf(fewest)];
  };

  // "Take" -> "Take 3" when "Take 1" and "Take 2" exist.
  M.nextTrackName = function (project, base) {
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$');
    let n = 0;
    for (const t of project.tracks) {
      const m = re.exec(t.name);
      if (m) n = Math.max(n, +m[1]);
    }
    return base + ' ' + (n + 1);
  };

  M.createTrack = function (project, name) {
    return {
      id: SS.uid('t'),
      name: name || M.nextTrackName(project, 'Track'),
      color: M.pickColor(project),
      gain: 0,
      pan: 0,
      mute: false,
      solo: false,
      clips: [],
    };
  };

  M.clipEnd = (c) => c.start + c.dur;

  M.trackEnd = function (track) {
    let end = 0;
    for (const c of track.clips) end = Math.max(end, c.start + c.dur);
    return end;
  };

  M.projectEnd = function (project) {
    let end = 0;
    for (const t of project.tracks) end = Math.max(end, M.trackEnd(t));
    return end;
  };

  M.findTrack = (project, id) => project.tracks.find((t) => t.id === id) || null;

  M.findClip = function (project, clipId) {
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  };

  // What you hear: muted tracks are skipped, and if anything is soloed only soloed tracks play.
  M.isAudible = function (project, track) {
    if (track.mute) return false;
    return !project.tracks.some((t) => t.solo) || track.solo;
  };

  M.referencedSources = function (project) {
    const ids = new Set();
    for (const t of project.tracks) for (const c of t.clips) ids.add(c.src);
    return ids;
  };

  /** Removes slivers, pulls clips back from before 0:00 and keeps clips sorted by start time. */
  M.normalizeTrack = function (track) {
    for (const c of track.clips) {
      if (c.start < 0) {
        c.offset -= c.start;
        c.dur += c.start;
        c.start = 0;
      }
    }
    track.clips = track.clips.filter((c) => c.dur > EPS);
    track.clips.sort((a, b) => a.start - b.start);
  };

  /** Clears [t0, t1) on a track, cutting clips that straddle the edges. `keep` is left alone. */
  M.carve = function (track, t0, t1, keep) {
    if (t1 - t0 <= EPS) return;
    const out = [];
    for (const c of track.clips) {
      const cs = c.start;
      const ce = c.start + c.dur;
      if (c === keep || ce <= t0 + EPS || cs >= t1 - EPS) {
        out.push(c);
        continue;
      }
      const hasLeft = cs < t0 - EPS;
      if (hasLeft) out.push(Object.assign({}, c, { dur: t0 - cs }));
      if (ce > t1 + EPS) {
        out.push(Object.assign({}, c, {
          id: hasLeft ? SS.uid('c') : c.id,
          start: t1,
          offset: c.offset + (t1 - cs),
          dur: ce - t1,
        }));
      }
    }
    track.clips = out;
    M.normalizeTrack(track);
  };

  /** Cuts any clip that spans time t into two clips. Returns true if something was split. */
  M.splitTrackAt = function (track, t) {
    let did = false;
    const out = [];
    for (const c of track.clips) {
      const cs = c.start;
      const ce = cs + c.dur;
      if (t > cs + EPS && t < ce - EPS) {
        out.push(Object.assign({}, c, { dur: t - cs }));
        out.push(Object.assign({}, c, { id: SS.uid('c'), start: t, offset: c.offset + (t - cs), dur: ce - t }));
        did = true;
      } else out.push(c);
    }
    track.clips = out;
    return did;
  };

  const selected = (project, trackIds) => project.tracks.filter((t) => trackIds.has(t.id));

  /** Deletes [t0, t1) on the given tracks. ripple=true pulls later audio left to close the gap. */
  M.deleteRange = function (project, trackIds, t0, t1, ripple) {
    const shift = t1 - t0;
    for (const track of selected(project, trackIds)) {
      M.carve(track, t0, t1);
      if (ripple) for (const c of track.clips) if (c.start >= t1 - EPS) c.start -= shift;
      M.normalizeTrack(track);
    }
  };

  /** Keeps only [t0, t1) on the given tracks. */
  M.trimToRange = function (project, trackIds, t0, t1) {
    for (const track of selected(project, trackIds)) {
      M.carve(track, -1e9, t0);
      M.carve(track, t1, 1e9);
    }
  };

  /** The parts of a track's clips that fall inside [t0, t1). */
  M.clipsInRange = function (track, t0, t1) {
    const out = [];
    for (const c of track.clips) {
      const s = Math.max(c.start, t0);
      const e = Math.min(c.start + c.dur, t1);
      if (e - s > EPS) out.push(Object.assign({}, c, { start: s, offset: c.offset + (s - c.start), dur: e - s }));
    }
    return out;
  };

  /** Clipboard contents for [t0, t1) of the given tracks (times relative to t0). */
  M.copyRange = function (project, trackIds, t0, t1) {
    return {
      dur: t1 - t0,
      tracks: selected(project, trackIds).map((t) => ({
        name: t.name,
        clips: M.clipsInRange(t, t0, t1).map((c) => ({
          src: c.src, name: c.name, offset: c.offset, start: c.start - t0, dur: c.dur,
        })),
      })),
    };
  };

  /**
   * Pastes clipboard tracks onto targetIds (in order) at time t, replacing what was there.
   * Extra clipboard tracks become new tracks. Returns the ids of the tracks pasted into.
   */
  M.paste = function (project, targetIds, t, clip, replaceRange) {
    const used = [];
    clip.tracks.forEach((ct, i) => {
      let track = M.findTrack(project, targetIds[i]);
      if (!track) {
        track = M.createTrack(project, ct.name);
        project.tracks.push(track);
      }
      if (replaceRange) M.carve(track, replaceRange[0], replaceRange[1]);
      M.carve(track, t, t + clip.dur);
      for (const c of ct.clips) {
        track.clips.push({ id: SS.uid('c'), src: c.src, name: c.name, offset: c.offset, start: t + c.start, dur: c.dur });
      }
      M.normalizeTrack(track);
      used.push(track.id);
    });
    return used;
  };

  /** Puts a clip on a track, replacing whatever it lands on. */
  M.insertClip = function (track, clip) {
    M.carve(track, clip.start, clip.start + clip.dur);
    track.clips.push(clip);
    M.normalizeTrack(track);
  };

  /** After a clip has been dragged into place: clear what's under it. */
  M.settleClip = function (track, clip) {
    if (clip.start < 0) clip.start = 0;
    M.carve(track, clip.start, clip.start + clip.dur, clip);
    M.normalizeTrack(track);
  };

  /** How far a clip's edges can be dragged: not past its neighbours or the ends of its audio. */
  M.trimBounds = function (track, clip, sourceDuration) {
    const cs = clip.start;
    const ce = clip.start + clip.dur;
    let prevEnd = 0;
    let nextStart = Infinity;
    for (const c of track.clips) {
      if (c === clip) continue;
      const e = c.start + c.dur;
      if (e <= cs + EPS) prevEnd = Math.max(prevEnd, e);
      if (c.start >= ce - EPS) nextStart = Math.min(nextStart, c.start);
    }
    const audioStart = cs - clip.offset;
    return {
      minStart: Math.max(prevEnd, audioStart, 0),
      maxEnd: Math.min(nextStart, audioStart + sourceDuration),
    };
  };

  M.setClipLeft = function (clip, newStart, bounds, minDur) {
    const end = clip.start + clip.dur;
    newStart = SS.clamp(newStart, bounds.minStart, end - minDur);
    const d = newStart - clip.start;
    clip.start = newStart;
    clip.offset += d;
    clip.dur -= d;
  };

  M.setClipRight = function (clip, newEnd, bounds, minDur) {
    newEnd = SS.clamp(newEnd, clip.start + minDur, bounds.maxEnd);
    clip.dur = newEnd - clip.start;
  };

  /** Number of sample frames for a stem that runs from 0:00 to `endSec`. Same for every stem. */
  M.stemFrames = function (endSec, sampleRate) {
    return Math.max(1, Math.ceil(endSec * sampleRate - 1e-7));
  };

  /** Rebuilds a project from untrusted JSON (autosave or a project file), dropping anything malformed. */
  M.sanitizeProject = function (p) {
    p = p && typeof p === 'object' ? p : {};
    const out = M.newProject(typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : 'My Song',
      SS.finite(p.sampleRate, 48000));
    out.bpm = SS.clamp(SS.finite(p.bpm, 120), M.MIN_BPM, M.MAX_BPM);
    out.beatsPerBar = SS.clamp(Math.round(SS.finite(p.beatsPerBar, 4)), 1, 12);
    out.showBeats = !!p.showBeats;
    for (const t of Array.isArray(p.tracks) ? p.tracks : []) {
      if (!t || typeof t !== 'object') continue;
      const track = {
        id: typeof t.id === 'string' && t.id ? t.id : SS.uid('t'),
        name: typeof t.name === 'string' && t.name.trim() ? t.name.slice(0, 60) : 'Track',
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : M.pickColor(out),
        gain: SS.clamp(SS.finite(t.gain, 0), SS.MIN_DB, SS.MAX_DB),
        pan: SS.clamp(SS.finite(t.pan, 0), -1, 1),
        mute: !!t.mute,
        solo: !!t.solo,
        clips: [],
      };
      for (const c of Array.isArray(t.clips) ? t.clips : []) {
        if (!c || typeof c.src !== 'string') continue;
        const clip = {
          id: typeof c.id === 'string' && c.id ? c.id : SS.uid('c'),
          src: c.src,
          name: typeof c.name === 'string' ? c.name.slice(0, 60) : '',
          offset: Math.max(0, SS.finite(c.offset, 0)),
          start: Math.max(0, SS.finite(c.start, 0)),
          dur: SS.finite(c.dur, 0),
        };
        if (clip.dur > EPS) track.clips.push(clip);
      }
      M.normalizeTrack(track);
      // Older or hand-edited files might contain overlaps; later clips win, like a fresh recording would.
      const clips = track.clips;
      track.clips = [];
      for (const c of clips) M.insertClip(track, c);
      out.tracks.push(track);
    }
    return out;
  };

  /** Drops clips whose audio is missing. Returns how many were dropped. */
  M.dropMissingSources = function (project, hasSource) {
    let dropped = 0;
    for (const t of project.tracks) {
      const before = t.clips.length;
      t.clips = t.clips.filter((c) => hasSource(c.src));
      dropped += before - t.clips.length;
    }
    return dropped;
  };

  // The part of the project that undo/redo tracks.
  M.serializeState = (project) => JSON.stringify({
    name: project.name,
    bpm: project.bpm,
    beatsPerBar: project.beatsPerBar,
    showBeats: project.showBeats,
    tracks: project.tracks,
  });

  /** Seconds per beat and per bar, or null if the bars-and-beats grid is off. */
  M.beatGrid = function (project) {
    if (!project.showBeats || !(project.bpm > 0)) return null;
    const beat = 60 / project.bpm;
    return { beat, bar: beat * project.beatsPerBar, beatsPerBar: project.beatsPerBar };
  };

  /** Undo history of serialized states. Each entry remembers the label of the action it undoes. */
  class History {
    constructor(limit) {
      this.limit = limit || 100;
      this.undoStack = [];
      this.redoStack = [];
    }
    push(entry) {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undoLabel() { return this.canUndo() ? this.undoStack[this.undoStack.length - 1].label : ''; }
    redoLabel() { return this.canRedo() ? this.redoStack[this.redoStack.length - 1].label : ''; }
    undo(current) {
      const entry = this.undoStack.pop();
      if (!entry) return null;
      this.redoStack.push({ label: entry.label, state: current });
      return entry;
    }
    redo(current) {
      const entry = this.redoStack.pop();
      if (!entry) return null;
      this.undoStack.push({ label: entry.label, state: current });
      return entry;
    }
    clear() {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }
    referencedSources() {
      const ids = new Set();
      const re = /"src":"([^"]+)"/g;
      for (const e of this.undoStack.concat(this.redoStack)) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(e.state))) ids.add(m[1]);
      }
      return ids;
    }
  }
  SS.History = History;

  if (typeof module === 'object' && module.exports) module.exports = SS;
})(typeof window !== 'undefined' ? window : globalThis);
