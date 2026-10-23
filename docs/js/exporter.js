/* Audabook — rendering tracks to audio files and saving them (to a folder, a .zip, or one file). */
(function (root) {
  'use strict';
  const SS = root.SS;

  /**
   * Renders tracks into one stereo AudioBuffer of exactly opts.frames samples, starting at 0:00.
   * opts: { sampleRate, frames, applyMix } — applyMix uses each track's volume and pan.
   */
  SS.renderTracks = function (tracks, sources, opts) {
    const ctx = new OfflineAudioContext(2, opts.frames, opts.sampleRate);
    for (const track of tracks) {
      const gain = ctx.createGain();
      gain.gain.value = opts.applyMix ? SS.dbToGain(track.gain) : 1;
      if (opts.applyMix) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = track.pan;
        gain.connect(pan);
        pan.connect(ctx.destination);
      } else {
        gain.connect(ctx.destination);
      }
      SS.scheduleTrack(ctx, gain, track, sources, 0, null, 0);
    }
    return ctx.startRendering();
  };

  SS.channelsOf = function (buffer) {
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  };

  /**
   * True when a WAV made from this buffer would audibly distort. Loud mastered beats often peak a hair
   * over full scale after sample-rate conversion; a handful of such samples can't be heard, so they don't count.
   */
  SS.audiblyClips = function (buffer) {
    let peak = 0;
    let over = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > 1) over++;
        if (v > peak) peak = v;
      }
    }
    return peak > 1.12 || over > 2000;
  };

  SS.bufferPeak = function (buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const v = d[i] < 0 ? -d[i] : d[i];
        if (v > peak) peak = v;
      }
    }
    return peak;
  };

  async function freeName(parent, base) {
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? base : base + ' (' + n + ')';
      try {
        await parent.getDirectoryHandle(name);
      } catch (e) {
        if (e.name === 'NotFoundError') return name;
        if (e.name !== 'TypeMismatchError') throw e; // a file already has that name: try the next one
      }
    }
    return base + ' ' + Date.now();
  }

  /** Writes files into a new folder the person picks. Needs the File System Access API (Chrome 86+). */
  class FolderTarget {
    static supported() {
      return typeof root.showDirectoryPicker === 'function';
    }
    // Must be called straight from a click, before any slow work, or Chrome blocks the folder picker.
    static async create(folderName) {
      const parent = await root.showDirectoryPicker({ id: 'audabook-export', mode: 'readwrite', startIn: 'downloads' });
      const name = await freeName(parent, folderName);
      const dir = await parent.getDirectoryHandle(name, { create: true });
      return new FolderTarget(dir, parent.name + ' › ' + name);
    }
    constructor(dir, label) {
      this.dir = dir;
      this.label = label;
    }
    async add(fileName, data) {
      const fh = await this.dir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(data);
        await w.close();
      } catch (e) {
        try { await w.abort(); } catch (e2) { /* already closed */ }
        throw e;
      }
    }
    async finish() {
      return 'the folder “' + this.label + '”';
    }
  }
  SS.FolderTarget = FolderTarget;

  /** Collects files into one .zip download (inside a folder, so unzipping keeps them together). */
  class ZipTarget {
    constructor(zipName, folder) {
      this.zipName = zipName;
      this.prefix = folder ? folder + '/' : '';
      this.zip = new SS.ZipWriter();
    }
    async add(fileName, data) {
      this.zip.add(this.prefix + fileName, new Uint8Array(data));
    }
    async finish() {
      SS.ui.downloadBlob(this.zip.toBlob(), this.zipName);
      return 'your Downloads folder as “' + this.zipName + '”';
    }
  }
  SS.ZipTarget = ZipTarget;

  /**
   * Asks where to save one file (when Chrome supports it), else falls back to a normal download.
   * Resolves to null if the person cancels. Call straight from a click.
   * type: { id, description, mime, ext }
   */
  SS.pickSaveFile = async function (suggestedName, type) {
    if (typeof root.showSaveFilePicker === 'function') {
      let handle = null;
      try {
        const accept = {};
        accept[type.mime] = [type.ext];
        handle = await root.showSaveFilePicker({
          suggestedName, id: type.id, startIn: 'downloads', types: [{ description: type.description, accept }],
        });
      } catch (e) {
        if (e.name === 'AbortError') return null;
        console.warn('Save picker unavailable, downloading instead:', e);
      }
      if (handle) {
        return {
          async save(blob) {
            const w = await handle.createWritable();
            await w.write(blob);
            await w.close();
            return '“' + handle.name + '”';
          },
        };
      }
    }
    return {
      async save(blob) {
        SS.ui.downloadBlob(blob, suggestedName);
        return 'your Downloads folder as “' + suggestedName + '”';
      },
    };
  };
})(window);
