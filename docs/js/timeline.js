/* Audabook — the timeline: ruler, track rows, waveform drawing, and mouse/touch editing.
   Waveforms are drawn only for the visible stretch of time and only when something changes,
   which keeps scrolling smooth on low-end Chromebooks. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const UI = SS.ui;
  const el = UI.el;

  const CLIP_PAD = 4; // gap above and below each clip inside its lane
  const CLIP_BAR = 18; // the draggable name bar along the top of each clip
  const EDGE_GRAB = 7; // how close (px) to a clip edge counts as grabbing it to trim
  const SNAP_PX = 8;
  const MIN_PPS = 0.25; // most zoomed-out: pixels per second
  const MIN_CLIP = 0.01; // shortest clip a trim can leave (s)
  // [major tick spacing in seconds, minor divisions]
  const TICKS = [[0.001, 5], [0.002, 4], [0.005, 5], [0.01, 5], [0.02, 4], [0.05, 5], [0.1, 5], [0.2, 4], [0.5, 5],
    [1, 4], [2, 4], [5, 5], [10, 5], [15, 3], [30, 6], [60, 6], [120, 4], [300, 5], [600, 5], [1200, 4], [1800, 6], [3600, 6]];

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  class Timeline {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('timeline');
      this.ruler = document.getElementById('ruler');
      this.rulerCtx = this.ruler.getContext('2d');
      this.scroller = document.getElementById('tracks-scroll');
      this.tracksEl = document.getElementById('tracks');
      this.emptyEl = document.getElementById('empty');
      this.playheadEl = document.getElementById('playhead');
      this.hscroll = document.getElementById('hscroll');
      this.hthumb = document.getElementById('hthumb');
      this.rows = new Map();
      this.pps = 20;
      this.scroll = 0;
      this.laneWidth = 600;
      this.trackH = 112;
      this.headerW = 216;
      this.rulerH = 28;
      this.dpr = 1;
      this.dirty = new Set();
      this.dirtyAll = true;
      this.frame = 0;
      this.drag = null;
      this.autoTimer = 0;
      this.autoV = 0;
      this.out = [0, 0];
      this.readTheme();
      this.bindRuler();
      this.bindScrollbar();
      this.bindWheel();
      if (root.ResizeObserver) new ResizeObserver(() => this.measure()).observe(this.scroller);
      else root.addEventListener('resize', () => this.measure());
      this.measure();
    }

    // ---- geometry -------------------------------------------------------------------------

    timeToX(t) {
      return (t - this.scroll) * this.pps;
    }

    xToTime(x) {
      return this.scroll + x / this.pps;
    }

    get visibleDur() {
      return this.laneWidth / this.pps;
    }

    contentDur() {
      const end = Math.max(M.projectEnd(this.app.project), this.app.liveEnd());
      return Math.max(end + Math.max(5, this.visibleDur * 0.3), this.visibleDur);
    }

    maxPps() {
      return Math.max(4000, this.app.sampleRate());
    }

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (name) => cs.getPropertyValue(name).trim();
      this.colors = {
        grid: v('--lane-grid'),
        gridStrong: v('--lane-grid-strong'),
        rulerBg: v('--ruler-bg'),
        rulerText: v('--text-dim'),
        tick: v('--ruler-tick'),
        sel: v('--sel-fill'),
        border: v('--border'),
        rec: v('--rec'),
        dark: v('--is-dark') === '1',
      };
      this.font = getComputedStyle(document.body).fontFamily;
      this.invalidate();
    }

    measure() {
      const cs = getComputedStyle(document.documentElement);
      this.headerW = parseFloat(cs.getPropertyValue('--header-w')) || 216;
      this.trackH = parseFloat(cs.getPropertyValue('--track-h')) || 112;
      this.rulerH = this.ruler.parentNode.clientHeight || 28;
      this.dpr = Math.min(2, root.devicePixelRatio || 1);
      this.laneWidth = Math.max(80, this.scroller.clientWidth - this.headerW);
      this.sizeCanvas(this.ruler, this.laneWidth, this.rulerH);
      for (const r of this.rows.values()) this.sizeCanvas(r.canvas, this.laneWidth, this.trackH);
      this.setScroll(this.scroll);
      this.invalidate();
    }

    sizeCanvas(canvas, w, h) {
      const pw = Math.round(w * this.dpr);
      const ph = Math.round(h * this.dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }

    // ---- scrolling & zoom -------------------------------------------------------------------

    setScroll(sec) {
      const max = Math.max(0, this.contentDur() - this.visibleDur);
      const s = SS.clamp(sec, 0, max);
      if (s !== this.scroll) {
        this.scroll = s;
        this.invalidate();
      } else {
        this.updateScrollbar();
      }
    }

    zoomBy(factor, anchorX) {
      if (anchorX == null) {
        const px = this.timeToX(this.app.playheadTime());
        anchorX = px >= 0 && px <= this.laneWidth ? px : this.laneWidth / 2;
      }
      const t = this.xToTime(anchorX);
      const pps = SS.clamp(this.pps * factor, MIN_PPS, this.maxPps());
      if (pps === this.pps) return;
      this.pps = pps;
      this.scroll = Math.max(0, t - anchorX / pps);
      this.setScroll(this.scroll);
      this.invalidate();
    }

    zoomFit() {
      const end = Math.max(M.projectEnd(this.app.project), 10);
      this.pps = SS.clamp(this.laneWidth / (end * 1.03), MIN_PPS, this.maxPps());
      this.scroll = 0;
      this.invalidate();
    }

    showTime(t) {
      if (t < this.scroll || t > this.scroll + this.visibleDur) this.setScroll(t - this.visibleDur * 0.1);
    }

    followPlayhead(t) {
      const vis = this.visibleDur;
      if (t > this.scroll + vis * 0.97 || t < this.scroll) this.setScroll(t - vis * 0.05);
    }

    // ---- rows ------------------------------------------------------------------------------

    createRow(track) {
      const id = track.id;
      const app = this.app;
      const name = el('input', { class: 'th-name', type: 'text', spellcheck: 'false', maxlength: '60', 'aria-label': 'Track name' });
      const del = el('button', { class: 'icon-btn th-del', type: 'button', title: 'Delete this track' }, [UI.icon('close', 16)]);
      const mute = el('button', { class: 'pill th-mute', type: 'button', title: 'Mute: silence this track (it is left out of stem exports)' }, 'Mute');
      const solo = el('button', { class: 'pill th-solo', type: 'button', title: 'Solo: hear only this track' }, 'Solo');
      const gain = el('input', { class: 'th-gain', type: 'range', min: String(SS.MIN_DB), max: String(SS.MAX_DB), step: '0.5', 'aria-label': 'Volume', title: 'Volume (double-click to reset)' });
      const gainOut = el('output', { class: 'th-val' });
      const pan = el('input', { class: 'th-pan', type: 'range', min: '-1', max: '1', step: '0.02', 'aria-label': 'Pan', title: 'Pan left/right (double-click to center)' });
      const panOut = el('output', { class: 'th-val' });
      const head = el('div', { class: 'track-head' }, [
        el('div', { class: 'th-top' }, [el('span', { class: 'th-swatch' }), name, del]),
        el('div', { class: 'th-buttons' }, [mute, solo]),
        el('label', { class: 'th-slider' }, [el('span', { class: 'th-lbl', text: 'Vol' }), gain, gainOut]),
        el('label', { class: 'th-slider' }, [el('span', { class: 'th-lbl', text: 'Pan' }), pan, panOut]),
      ]);
      const canvas = el('canvas', { class: 'lane-canvas' });
      const sel = el('div', { class: 'lane-sel', hidden: true });
      const lane = el('div', { class: 'track-lane' }, [canvas, sel]);
      const row = el('div', { class: 'track', 'data-id': id }, [head, lane]);
      const r = { id, row, head, name, mute, solo, gain, gainOut, pan, panOut, lane, canvas, ctx: canvas.getContext('2d'), sel };

      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input[type=range]')) return;
        app.selectTrack(id, e.shiftKey || e.ctrlKey || e.metaKey);
      });
      name.addEventListener('change', () => app.renameTrack(id, name.value));
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') name.blur();
        else if (e.key === 'Escape') {
          const t = M.findTrack(app.project, id);
          if (t) name.value = t.name;
          name.blur();
        }
      });
      del.addEventListener('click', () => app.deleteTrack(id));
      mute.addEventListener('click', () => app.toggleTrackFlag(id, 'mute'));
      solo.addEventListener('click', () => app.toggleTrackFlag(id, 'solo'));
      gain.addEventListener('input', () => app.setTrackLive(id, 'gain', +gain.value));
      gain.addEventListener('change', () => app.endGesture('Change volume', { mix: true }));
      gain.addEventListener('dblclick', () => {
        app.setTrackLive(id, 'gain', 0);
        app.endGesture('Reset volume', { mix: true });
      });
      pan.addEventListener('input', () => app.setTrackLive(id, 'pan', Math.abs(+pan.value) < 0.04 ? 0 : +pan.value));
      pan.addEventListener('change', () => app.endGesture('Change pan', { mix: true }));
      pan.addEventListener('dblclick', () => {
        app.setTrackLive(id, 'pan', 0);
        app.endGesture('Center pan', { mix: true });
      });

      lane.addEventListener('pointerdown', (e) => this.lanePointerDown(e, r));
      lane.addEventListener('pointermove', (e) => this.lanePointerMove(e, r));
      lane.addEventListener('pointerup', (e) => this.lanePointerUp(e, r));
      lane.addEventListener('pointercancel', (e) => this.lanePointerUp(e, r, true));
      lane.addEventListener('dblclick', (e) => this.laneDoubleClick(e, r));
      lane.addEventListener('contextmenu', (e) => e.preventDefault());
      return r;
    }

    syncRows() {
      const tracks = this.app.project.tracks;
      const anySolo = tracks.some((t) => t.solo);
      const seen = new Set();
      let prev = null;
      for (const t of tracks) {
        let r = this.rows.get(t.id);
        if (!r) {
          r = this.createRow(t);
          this.rows.set(t.id, r);
          this.sizeCanvas(r.canvas, this.laneWidth, this.trackH);
          this.dirty.add(t.id);
        }
        seen.add(t.id);
        const want = prev ? prev.row.nextSibling : this.tracksEl.firstChild;
        if (want !== r.row) this.tracksEl.insertBefore(r.row, want);
        prev = r;
        this.updateHeader(r, t, anySolo);
      }
      for (const [id, r] of this.rows) {
        if (!seen.has(id)) {
          r.row.remove();
          this.rows.delete(id);
        }
      }
      this.emptyEl.hidden = tracks.length > 0;
    }

    updateHeader(r, t, anySolo) {
      if (anySolo == null) anySolo = this.app.project.tracks.some((x) => x.solo);
      r.row.style.setProperty('--track-color', t.color);
      if (document.activeElement !== r.name && r.name.value !== t.name) r.name.value = t.name;
      r.mute.classList.toggle('on', t.mute);
      r.mute.setAttribute('aria-pressed', String(t.mute));
      r.solo.classList.toggle('on', t.solo);
      r.solo.setAttribute('aria-pressed', String(t.solo));
      if (+r.gain.value !== t.gain) r.gain.value = t.gain;
      if (+r.pan.value !== t.pan) r.pan.value = t.pan;
      r.gainOut.textContent = SS.formatDb(t.gain);
      r.panOut.textContent = SS.formatPan(t.pan);
      r.row.classList.toggle('selected', this.app.state.sel.tracks.has(t.id));
      const silent = t.mute || (anySolo && !t.solo);
      if (r.row.classList.contains('silent') !== silent) {
        r.row.classList.toggle('silent', silent);
        this.dirty.add(t.id);
        this.schedule();
      }
    }

    refreshHeaders() {
      const anySolo = this.app.project.tracks.some((t) => t.solo);
      for (const t of this.app.project.tracks) {
        const r = this.rows.get(t.id);
        if (r) this.updateHeader(r, t, anySolo);
      }
    }

    // ---- drawing ---------------------------------------------------------------------------

    invalidate(trackId) {
      if (trackId) this.dirty.add(trackId);
      else this.dirtyAll = true;
      this.schedule();
    }

    schedule() {
      if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
    }

    flush() {
      this.frame = 0;
      const all = this.dirtyAll;
      for (const t of this.app.project.tracks) {
        if (all || this.dirty.has(t.id)) {
          const r = this.rows.get(t.id);
          if (r) this.drawLane(r, t);
        }
      }
      this.dirty.clear();
      this.dirtyAll = false;
      this.drawRuler();
      this.updateOverlays();
      this.updateScrollbar();
    }

    ticks() {
      for (const [step, div] of TICKS) if (step * this.pps >= 80) return { major: step, minor: step / div };
      const last = TICKS[TICKS.length - 1];
      return { major: last[0], minor: last[0] / last[1] };
    }

    tickLabel(t, major) {
      if (major >= 1) return SS.formatTime(t, 0);
      return SS.formatTime(t, major >= 0.1 ? 1 : major >= 0.01 ? 2 : 3);
    }

    drawRuler() {
      const c = this.rulerCtx;
      const W = this.laneWidth;
      const H = this.rulerH;
      const col = this.colors;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.fillStyle = col.rulerBg;
      c.fillRect(0, 0, W, H);
      const sel = this.app.state.sel;
      if (sel.t1 - sel.t0 > 1e-9) {
        const x0 = Math.max(0, this.timeToX(sel.t0));
        const x1 = Math.min(W, this.timeToX(sel.t1));
        if (x1 > x0) {
          c.fillStyle = col.sel;
          c.fillRect(x0, 0, x1 - x0, H);
        }
      }
      c.font = '11px ' + this.font;
      c.textBaseline = 'top';
      const grid = M.beatGrid(this.app.project);
      if (grid) this.drawBeatRuler(c, grid, W, H);
      else this.drawTimeRuler(c, W, H);
      c.fillStyle = col.border;
      c.fillRect(0, H - 1, W, 1);
    }

    drawTimeRuler(c, W, H) {
      const { major, minor } = this.ticks();
      const perMajor = Math.round(major / minor);
      const i0 = Math.floor(this.scroll / minor);
      const i1 = Math.ceil((this.scroll + W / this.pps) / minor);
      c.fillStyle = this.colors.tick;
      for (let i = i0; i <= i1; i++) {
        const x = Math.round(this.timeToX(i * minor));
        const isMajor = i % perMajor === 0;
        c.fillRect(x, isMajor ? H - 11 : H - 5, 1, isMajor ? 11 : 5);
      }
      c.fillStyle = this.colors.rulerText;
      for (let i = Math.floor(i0 / perMajor) * perMajor; i <= i1; i += perMajor) {
        const x = Math.round(this.timeToX(i * minor));
        c.fillText(this.tickLabel(i * minor, major), x + 4, 4);
      }
    }

    // Bar numbers like a music app: "1", "2"... and "3.2" (bar 3, beat 2) when zoomed in.
    drawBeatRuler(c, grid, W, H) {
      const beatPx = grid.beat * this.pps;
      const barPx = grid.bar * this.pps;
      let every = 1; // label every Nth bar
      while (every * barPx < 44) every *= 2;
      const b0 = Math.floor(this.scroll / grid.beat);
      const b1 = Math.ceil((this.scroll + W / this.pps) / grid.beat);
      const showBeats = beatPx >= 5;
      const labelBeats = beatPx >= 38;
      c.fillStyle = this.colors.tick;
      for (let b = b0; b <= b1; b++) {
        const isBar = b % grid.beatsPerBar === 0;
        if (!isBar && !showBeats) continue;
        const x = Math.round(this.timeToX(b * grid.beat));
        c.fillRect(x, isBar ? H - 13 : H - 5, 1, isBar ? 13 : 5);
      }
      c.fillStyle = this.colors.rulerText;
      for (let b = b0; b <= b1; b++) {
        const bar = Math.floor(b / grid.beatsPerBar);
        const beatInBar = b - bar * grid.beatsPerBar;
        const x = Math.round(this.timeToX(b * grid.beat));
        if (beatInBar === 0 && bar % every === 0) {
          c.font = '600 11px ' + this.font;
          c.fillText(String(bar + 1), x + 4, 4);
        } else if (beatInBar !== 0 && labelBeats) {
          c.font = '10px ' + this.font;
          c.fillText(bar + 1 + '.' + (beatInBar + 1), x + 3, 6);
        }
      }
      c.font = '11px ' + this.font;
    }

    drawLane(r, track) {
      const c = r.ctx;
      const W = this.laneWidth;
      const H = this.trackH;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      this.drawGrid(c, W, H);
      const dragged = this.drag && this.drag.clip;
      for (const clip of track.clips) {
        if (clip !== dragged) this.drawClip(c, clip, this.app.sources.get(clip.src), track.color, W, H);
      }
      if (dragged && track.clips.indexOf(dragged) >= 0) {
        this.drawClip(c, dragged, this.app.sources.get(dragged.src), track.color, W, H, true);
      }
      const live = this.app.liveRecording(track.id);
      if (live) this.drawClip(c, live.clip, live.src, this.colors.rec, W, H, false, 'Recording…');
    }

    drawGrid(c, W, H) {
      const grid = M.beatGrid(this.app.project);
      const tEnd = this.scroll + W / this.pps;
      if (!grid) {
        const { major } = this.ticks();
        c.fillStyle = this.colors.grid;
        for (let i = Math.floor(this.scroll / major); i * major <= tEnd; i++) c.fillRect(Math.round(this.timeToX(i * major)), 0, 1, H);
        return;
      }
      const showBeats = grid.beat * this.pps >= 8;
      let every = 1;
      while (every * grid.bar * this.pps < 12) every *= 2;
      for (let b = Math.floor(this.scroll / grid.beat); b * grid.beat <= tEnd; b++) {
        const isBar = b % grid.beatsPerBar === 0;
        if (isBar && (b / grid.beatsPerBar) % every !== 0) continue;
        if (!isBar && !showBeats) continue;
        c.fillStyle = isBar ? this.colors.gridStrong : this.colors.grid;
        c.fillRect(Math.round(this.timeToX(b * grid.beat)), 0, 1, H);
      }
    }

    drawClip(c, clip, src, color, W, H, lifted, label) {
      const x0 = this.timeToX(clip.start);
      const x1 = this.timeToX(clip.start + clip.dur);
      if (x1 < -2 || x0 > W + 2) return;
      const top = CLIP_PAD;
      const bottom = H - CLIP_PAD - 1;
      const vx0 = Math.max(x0, -8);
      const vx1 = Math.min(x1, W + 8);
      const w = Math.max(2, vx1 - vx0);
      c.save();
      if (lifted) {
        c.shadowColor = 'rgba(0,0,0,0.35)';
        c.shadowBlur = 10;
        c.shadowOffsetY = 2;
      }
      c.fillStyle = rgba(color, this.colors.dark ? 0.2 : 0.14);
      roundRect(c, vx0, top, w, bottom - top, 5);
      c.fill();
      c.restore();
      c.save();
      roundRect(c, vx0, top, w, bottom - top, 5);
      c.clip();
      c.fillStyle = rgba(color, 0.92);
      c.fillRect(vx0, top, w, CLIP_BAR);
      const text = label || clip.name || (src && src.name) || 'Audio';
      if (x1 - Math.max(x0, 0) > 30) {
        c.fillStyle = '#fff';
        c.font = '600 11px ' + this.font;
        c.textBaseline = 'middle';
        c.fillText(text, Math.max(x0, 0) + 7, top + CLIP_BAR / 2 + 0.5);
      }
      if (src) this.drawWave(c, clip, src, color, x0, x1, top + CLIP_BAR + 3, bottom - 3, W);
      else {
        c.fillStyle = this.colors.rulerText;
        c.font = '11px ' + this.font;
        c.fillText('Audio missing', Math.max(x0, 0) + 7, (top + bottom) / 2 + 6);
      }
      c.restore();
      c.strokeStyle = rgba(color, lifted ? 1 : 0.75);
      c.lineWidth = lifted ? 2 : 1;
      roundRect(c, vx0 + 0.5, top + 0.5, w - 1, bottom - top - 1, 5);
      c.stroke();
    }

    drawWave(c, clip, src, color, x0, x1, yTop, yBot, W) {
      const rate = src.rate;
      const mid = Math.round((yTop + yBot) / 2);
      const half = (yBot - yTop) / 2;
      const px0 = Math.max(0, Math.floor(x0));
      const px1 = Math.min(W, Math.ceil(x1));
      c.fillStyle = rgba(color, 0.4);
      c.fillRect(px0, mid, px1 - px0, 1);
      c.fillStyle = color;
      const spp = rate / this.pps; // samples per pixel
      const clipS0 = clip.offset * rate;
      const clipS1 = (clip.offset + clip.dur) * rate;
      const out = this.out;
      if (spp >= 1) {
        for (let px = px0; px < px1; px++) {
          let s0 = clipS0 + (px - x0) * spp;
          let s1 = s0 + spp;
          if (s0 < clipS0) s0 = clipS0;
          if (s1 > clipS1) s1 = clipS1;
          if (s1 <= s0 || !SS.sampleRange(src, s0, s1, out)) continue;
          const hi = out[1] > 1 ? 1 : out[1];
          const lo = out[0] < -1 ? -1 : out[0];
          const y0 = mid - hi * half;
          c.fillRect(px, y0, 1, Math.max(1, mid - lo * half - y0));
        }
        return;
      }
      // Zoomed in past one sample per pixel: join the samples with a line.
      const chans = src.channels;
      if (!chans) return;
      const value = (i) => {
        let v = 0;
        for (let k = 0; k < chans.length; k++) v += chans[k][i];
        return v / chans.length;
      };
      const i0 = Math.max(Math.floor(clipS0), Math.floor(clipS0 + (px0 - x0) * spp) - 1);
      const i1 = Math.min(Math.ceil(clipS1) - 1, Math.ceil(clipS0 + (px1 - x0) * spp) + 1, src.length - 1);
      c.strokeStyle = color;
      c.lineWidth = 1.25;
      c.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i - clipS0) / spp;
        const y = mid - SS.clamp(value(i), -1, 1) * half;
        if (i === i0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
      if (1 / spp >= 8) {
        for (let i = i0; i <= i1; i++) {
          c.fillRect(x0 + (i - clipS0) / spp - 1.5, mid - SS.clamp(value(i), -1, 1) * half - 1.5, 3, 3);
        }
      }
    }

    updateOverlays() {
      const sel = this.app.state.sel;
      const hasRange = sel.t1 - sel.t0 > 1e-9;
      const x0 = this.timeToX(sel.t0);
      const x1 = this.timeToX(sel.t1);
      for (const [id, r] of this.rows) {
        const show = hasRange && sel.tracks.has(id) && x1 > 0 && x0 < this.laneWidth;
        if (show) {
          const a = Math.max(x0, 0);
          const b = Math.min(x1, this.laneWidth);
          r.sel.style.transform = 'translateX(' + a + 'px)';
          r.sel.style.width = Math.max(1, b - a) + 'px';
        }
        r.sel.hidden = !show;
      }
      this.updatePlayhead();
    }

    updatePlayhead(pos) {
      const t = pos != null ? pos : this.app.playheadTime();
      const x = this.timeToX(t);
      const visible = x >= -1 && x <= this.laneWidth + 1;
      this.playheadEl.hidden = !visible;
      if (visible) this.playheadEl.style.transform = 'translateX(' + (this.headerW + Math.round(x) - 1) + 'px)';
      this.playheadEl.classList.toggle('moving', this.app.state.playing);
      this.playheadEl.classList.toggle('recording', !!this.app.state.recording);
    }

    selectionChanged() {
      this.refreshHeaders();
      this.updateOverlays();
      this.drawRuler();
    }

    // ---- horizontal scrollbar ------------------------------------------------------------------

    updateScrollbar() {
      const total = this.contentDur();
      const vis = this.visibleDur;
      const trackW = this.hscroll.clientWidth;
      const frac = Math.min(1, vis / total);
      const thumbW = Math.max(36, trackW * frac);
      const maxScroll = Math.max(0, total - vis);
      const left = maxScroll > 0 ? (this.scroll / maxScroll) * (trackW - thumbW) : 0;
      this.hthumb.style.width = thumbW + 'px';
      this.hthumb.style.transform = 'translateX(' + left + 'px)';
      this.hscroll.classList.toggle('idle', frac >= 1);
      this.thumbGeom = { trackW, thumbW, maxScroll };
    }

    bindScrollbar() {
      let drag = null;
      this.hthumb.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hthumb.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, scroll: this.scroll };
        this.hthumb.classList.add('active');
      });
      this.hthumb.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const g = this.thumbGeom;
        const span = g.trackW - g.thumbW;
        if (span > 0) this.setScroll(drag.scroll + ((e.clientX - drag.x) / span) * g.maxScroll);
      });
      const end = () => {
        drag = null;
        this.hthumb.classList.remove('active');
      };
      this.hthumb.addEventListener('pointerup', end);
      this.hthumb.addEventListener('pointercancel', end);
      this.hscroll.addEventListener('pointerdown', (e) => {
        if (e.target !== this.hscroll) return;
        const thumb = this.hthumb.getBoundingClientRect();
        this.setScroll(this.scroll + (e.clientX < thumb.left ? -1 : 1) * this.visibleDur * 0.9);
      });
    }

    // ---- wheel: scroll sideways, Ctrl/pinch to zoom ---------------------------------------------

    bindWheel() {
      this.scroller.addEventListener('wheel', (e) => {
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.laneWidth : 1;
        const dx = e.deltaX * scale;
        const dy = e.deltaY * scale;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const laneLeft = this.scroller.getBoundingClientRect().left + this.headerW;
          this.zoomBy(Math.pow(1.0025, -dy), Math.max(0, e.clientX - laneLeft));
          return;
        }
        const sideways = e.shiftKey ? dy || dx : Math.abs(dx) > Math.abs(dy) ? dx : 0;
        if (sideways) {
          e.preventDefault();
          this.setScroll(this.scroll + sideways / this.pps);
        }
      }, { passive: false });
      this.ruler.addEventListener('wheel', (e) => {
        e.preventDefault();
        const scale = e.deltaMode === 1 ? 16 : 1;
        if (e.ctrlKey || e.metaKey) {
          this.zoomBy(Math.pow(1.0025, -e.deltaY * scale), e.offsetX);
        } else {
          this.setScroll(this.scroll + ((e.deltaX || e.deltaY) * scale) / this.pps);
        }
      }, { passive: false });
    }

    // ---- ruler: click or drag to move the playhead ----------------------------------------------

    bindRuler() {
      let dragging = false;
      const timeAt = (e) => Math.max(0, this.xToTime(e.clientX - this.ruler.getBoundingClientRect().left));
      this.ruler.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.ruler.setPointerCapture(e.pointerId);
        dragging = true;
        this.app.seek(timeAt(e));
      });
      this.ruler.addEventListener('pointermove', (e) => {
        if (dragging && !this.app.state.playing) this.app.seek(timeAt(e));
      });
      const end = (e) => {
        if (dragging && this.app.state.playing && !this.app.state.recording) this.app.seek(timeAt(e));
        dragging = false;
      };
      this.ruler.addEventListener('pointerup', end);
      this.ruler.addEventListener('pointercancel', () => (dragging = false));
    }

    // ---- lane editing ------------------------------------------------------------------------

    trackIndexAtY(clientY) {
      const tracks = this.app.project.tracks;
      for (let i = 0; i < tracks.length; i++) {
        const r = this.rows.get(tracks[i].id);
        if (r && clientY < r.row.getBoundingClientRect().bottom) return i;
      }
      return tracks.length - 1;
    }

    hitTest(track, x, y) {
      if (y < CLIP_PAD || y > this.trackH - CLIP_PAD) return null;
      for (let i = track.clips.length - 1; i >= 0; i--) {
        const clip = track.clips[i];
        const x0 = this.timeToX(clip.start);
        const x1 = this.timeToX(clip.start + clip.dur);
        if (x < x0 - EDGE_GRAB || x > x1 + EDGE_GRAB) continue;
        const grab = Math.min(EDGE_GRAB, Math.max(2, (x1 - x0) / 4));
        if (Math.abs(x - x0) <= grab) return { clip, zone: 'left' };
        if (Math.abs(x - x1) <= grab) return { clip, zone: 'right' };
        if (x < x0 || x > x1) continue;
        return { clip, zone: y <= CLIP_PAD + CLIP_BAR ? 'bar' : 'body' };
      }
      return null;
    }

    pointIn(e, r) {
      const b = r.lane.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top, left: b.left };
    }

    lanePointerDown(e, r) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const app = this.app;
      if (app.state.recording) return;
      const track = M.findTrack(app.project, r.id);
      if (!track) return;
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      e.preventDefault();
      r.lane.setPointerCapture(e.pointerId);
      const p = this.pointIn(e, r);
      const t = Math.max(0, this.xToTime(p.x));
      const hit = this.hitTest(track, p.x, p.y);
      const base = { pointerId: e.pointerId, row: r, startX: e.clientX, startY: e.clientY, laneLeft: p.left, moved: false, lastEvent: e };
      if (hit && hit.zone === 'bar') {
        app.beginGesture();
        this.drag = Object.assign(base, { type: 'move', clip: hit.clip, track, origStart: hit.clip.start, grabT: t });
        r.lane.style.cursor = 'grabbing';
      } else if (hit && (hit.zone === 'left' || hit.zone === 'right')) {
        const src = app.sources.get(hit.clip.src);
        app.beginGesture();
        this.drag = Object.assign(base, {
          type: 'trim', edge: hit.zone, clip: hit.clip, track,
          bounds: M.trimBounds(track, hit.clip, src ? src.duration : hit.clip.offset + hit.clip.dur),
        });
      } else {
        const sel = app.state.sel;
        const index = app.project.tracks.indexOf(track);
        let anchorT = this.snapTime(t, null, true);
        let anchorIndex = index;
        if (e.shiftKey && sel.tracks.size) {
          anchorT = Math.abs(t - sel.t0) < Math.abs(t - sel.t1) ? sel.t1 : sel.t0;
          const idxs = app.project.tracks.map((x, i) => (sel.tracks.has(x.id) ? i : -1)).filter((i) => i >= 0);
          anchorIndex = Math.abs(index - idxs[0]) > Math.abs(index - idxs[idxs.length - 1]) ? idxs[0] : idxs[idxs.length - 1];
        }
        this.drag = Object.assign(base, { type: 'select', anchorT, anchorIndex, trackId: track.id, clickT: anchorT, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
        if (e.shiftKey && sel.tracks.size) this.dragMove(e);
      }
    }

    lanePointerMove(e, r) {
      const d = this.drag;
      if (!d) {
        if (e.pointerType === 'mouse' && !this.app.state.recording) {
          const track = M.findTrack(this.app.project, r.id);
          const p = this.pointIn(e, r);
          const hit = track && this.hitTest(track, p.x, p.y);
          r.lane.style.cursor = !hit ? 'text' : hit.zone === 'bar' ? 'grab' : hit.zone === 'body' ? 'text' : 'ew-resize';
        }
        return;
      }
      if (e.pointerId !== d.pointerId) return;
      d.lastEvent = e;
      if (!d.moved && Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return;
      d.moved = true;
      this.dragMove(e);
      this.autoScroll(e.clientX - d.laneLeft);
    }

    dragMove(e) {
      const d = this.drag;
      if (!d) return;
      const app = this.app;
      const t = Math.max(0, this.xToTime(e.clientX - d.laneLeft));
      if (d.type === 'select') {
        const idx = this.trackIndexAtY(e.clientY);
        const lo = Math.min(idx, d.anchorIndex);
        const hi = Math.max(idx, d.anchorIndex);
        const ids = app.project.tracks.slice(lo, hi + 1).map((x) => x.id);
        const st = this.snapTime(t, null, true); // with the beat grid on, selections land on beats
        app.setSelection(Math.min(d.anchorT, st), Math.max(d.anchorT, st), ids);
      } else if (d.type === 'move') {
        const start = this.snapStart(d.clip, Math.max(0, d.origStart + (t - d.grabT)));
        const target = app.project.tracks[this.trackIndexAtY(e.clientY)];
        if (target && target !== d.track) {
          d.track.clips.splice(d.track.clips.indexOf(d.clip), 1);
          this.invalidate(d.track.id);
          target.clips.push(d.clip);
          d.track = target;
        }
        d.clip.start = start;
        this.invalidate(d.track.id);
        app.liveEdit();
      } else if (d.type === 'trim') {
        const snapped = this.snapTime(t, d.clip);
        if (d.edge === 'left') M.setClipLeft(d.clip, snapped, d.bounds, MIN_CLIP);
        else M.setClipRight(d.clip, snapped, d.bounds, MIN_CLIP);
        this.invalidate(d.track.id);
        app.liveEdit();
      }
    }

    lanePointerUp(e, r, cancelled) {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.drag = null;
      this.autoV = 0;
      const app = this.app;
      r.lane.style.cursor = '';
      if (d.type === 'select') {
        if (!d.moved && !cancelled) app.clickLane(d.trackId, d.clickT, d.shift, d.ctrl);
      } else if (d.moved && !cancelled) {
        M.settleClip(d.track, d.clip);
        app.endGesture(d.type === 'move' ? 'Move clip' : 'Trim clip');
        if (d.type === 'move') app.setSelection(d.clip.start, d.clip.start + d.clip.dur, [d.track.id]);
      } else {
        app.endGesture('Move clip'); // nothing changed, so nothing is added to undo
        if (!cancelled && d.type === 'move') app.setSelection(d.clip.start, d.clip.start + d.clip.dur, [d.track.id]);
      }
      this.invalidate();
    }

    laneDoubleClick(e, r) {
      const track = M.findTrack(this.app.project, r.id);
      if (!track || this.app.state.recording) return;
      const p = this.pointIn(e, r);
      const hit = this.hitTest(track, p.x, p.y);
      if (hit) this.app.setSelection(hit.clip.start, hit.clip.start + hit.clip.dur, [track.id]);
    }

    autoScroll(x) {
      this.autoV = x < 0 ? x : x > this.laneWidth ? x - this.laneWidth : 0;
      if (!this.autoV || this.autoTimer) return;
      const step = () => {
        if (!this.drag || !this.autoV) {
          this.autoTimer = 0;
          return;
        }
        this.setScroll(this.scroll + (SS.clamp(this.autoV, -60, 60) * 0.5) / this.pps);
        this.dragMove(this.drag.lastEvent);
        this.autoTimer = requestAnimationFrame(step);
      };
      this.autoTimer = requestAnimationFrame(step);
    }

    // Snap points: song start, the cursor, and the edges of other clips.
    snapTargets(exclude) {
      const out = [0, this.app.state.cursor];
      for (const t of this.app.project.tracks) {
        for (const c of t.clips) if (c !== exclude) out.push(c.start, c.start + c.dur);
      }
      return out;
    }

    // Nearest beat (or bar, when beats are too close together to aim at), if the beat grid is on.
    gridPoint(t) {
      const grid = M.beatGrid(this.app.project);
      if (!grid) return null;
      const step = grid.beat * this.pps >= 14 ? grid.beat : grid.bar;
      return Math.max(0, Math.round(t / step) * step);
    }

    snapStart(clip, start) {
      const tol = SNAP_PX / this.pps;
      let best = start;
      let bestD = tol;
      const targets = this.snapTargets(clip);
      const gs = this.gridPoint(start);
      const ge = this.gridPoint(start + clip.dur);
      if (gs != null) targets.push(gs, ge);
      for (const target of targets) {
        for (const cand of [target, target - clip.dur]) {
          const dist = Math.abs(cand - start);
          if (dist < bestD) {
            bestD = dist;
            best = cand;
          }
        }
      }
      return Math.max(0, best);
    }

    snapTime(t, exclude, gridOnly) {
      const tol = SNAP_PX / this.pps;
      let best = t;
      let bestD = tol;
      const targets = gridOnly ? [] : this.snapTargets(exclude);
      const g = this.gridPoint(t);
      if (g != null) targets.push(g);
      for (const target of targets) {
        const dist = Math.abs(target - t);
        if (dist < bestD) {
          bestD = dist;
          best = target;
        }
      }
      return best;
    }
  }

  SS.Timeline = Timeline;
})(window);
