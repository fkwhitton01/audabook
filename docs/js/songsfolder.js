/* Audabook — the songs folder: a copy of every song as real files in a folder she picks (ideally Google Drive),
   so clearing browsing data, resetting the Chromebook, or getting a new one never loses her music. My Songs inside
   the browser stays the fast working copy; this folder is kept in step with it.

   Layout:  <folder>/<Song name>.song.json   one small file per song (the arrangement)
            <folder>/audio/<id>.wav          each recording or import, written once (32-bit float, lossless)
            <folder>/About these files.txt */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const FOLDER_NAME = 'Audabook Songs';
  const SONG_EXT = '.song.json';
  const ABOUT = 'About these files.txt';
  const ABOUT_TEXT = [
    'This folder holds your Audabook songs. Audabook saves here by itself while you work.',
    '',
    'Please don’t rename, move, or edit the files inside.',
    '',
    'To get your songs back (after clearing browsing data, or on another Chromebook):',
    'open Audabook, click My Songs, choose "Keep my songs safe" or "Find my songs", and pick this folder.',
    '',
  ].join('\r\n');

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function exists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function writeFile(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
      await w.close(); // the old file is only replaced once the new one is complete
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* already closed */ }
      throw e;
    }
  }

  async function readJson(handle) {
    return JSON.parse(await (await handle.getFile()).text());
  }

  class SongsFolder {
    constructor(store) {
      this.store = store;
      this.handle = null; // the songs folder
      this.audio = null; // its audio/ subfolder
      this.label = '';
      this.status = 'none'; // none | connected | needs-permission | unreachable
      this.known = new Set(); // audio ids known to be in the folder already
      this.owners = new Map(); // song file name -> song id
      this.queue = Promise.resolve();
      this.onChange = null;
    }

    static supported() {
      return typeof root.showDirectoryPicker === 'function';
    }

    get connected() {
      return this.status === 'connected';
    }

    setStatus(status) {
      this.status = status;
      if (this.onChange) this.onChange(status);
    }

    /** Runs folder work one job at a time, so writes never overlap. */
    run(job) {
      const p = this.queue.then(() => (this.connected ? job() : undefined));
      this.queue = p.catch((e) => this.failed(e));
      return p;
    }

    failed(e) {
      console.warn('Songs folder:', e);
      if (!e) return;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') this.setStatus('needs-permission');
      else if (e.name === 'NotFoundError' || e.name === 'InvalidStateError' || e.name === 'NoModificationAllowedError') this.setStatus('unreachable');
    }

    /** At startup: reconnect to the folder chosen before, if Chrome still allows it. */
    async load() {
      let saved = null;
      try {
        saved = await this.store.getFolder();
      } catch (e) { /* no folder yet */ }
      if (!saved || !saved.handle) return this.setStatus('none');
      this.handle = saved.handle;
      this.label = saved.label || saved.handle.name;
      let perm = 'granted';
      try {
        if (this.handle.queryPermission) perm = await this.handle.queryPermission({ mode: 'readwrite' });
      } catch (e) {
        perm = 'prompt';
      }
      if (perm !== 'granted') return this.setStatus('needs-permission');
      try {
        await this.attach(this.handle);
      } catch (e) {
        this.failed(e);
        if (this.status === 'none') this.setStatus('unreachable');
      }
    }

    async attach(handle) {
      this.audio = await handle.getDirectoryHandle('audio', { create: true });
      if (!(await exists(handle, ABOUT))) await writeFile(handle, ABOUT, ABOUT_TEXT);
      this.handle = handle;
      this.known.clear();
      this.owners.clear();
      this.setStatus('connected');
    }

    /** Asks her to pick a folder. Must be called straight from a click. */
    async choose() {
      const picked = await root.showDirectoryPicker({ id: 'audabook-songs', mode: 'readwrite', startIn: 'documents' });
      const dir = await this.songsDirIn(picked);
      await this.attach(dir);
      this.label = dir === picked || !picked.name ? dir.name : picked.name + ' › ' + dir.name;
      await this.store.setFolder({ handle: dir, label: this.label });
    }

    /** Asks Chrome for permission again (after it lapsed). Must be called straight from a click. */
    async reconnect() {
      if (!this.handle) return false;
      const perm = this.handle.requestPermission ? await this.handle.requestPermission({ mode: 'readwrite' }) : 'granted';
      if (perm !== 'granted') return false;
      await this.attach(this.handle);
      return true;
    }

    // Use the picked folder if it already holds songs; otherwise make "Audabook Songs" inside it.
    async songsDirIn(picked) {
      if (picked.name === FOLDER_NAME) return picked;
      let n = 0;
      for await (const name of picked.keys()) {
        if (name.endsWith(SONG_EXT) || name === ABOUT) return picked;
        if (++n > 500) break;
      }
      return picked.getDirectoryHandle(FOLDER_NAME, { create: true });
    }

    async hasAudio(id) {
      if (this.known.has(id)) return true;
      if (await exists(this.audio, id + '.wav')) {
        this.known.add(id);
        return true;
      }
      return false;
    }

    async writeAudio(id, channels, sampleRate) {
      await writeFile(this.audio, id + '.wav', SS.encodeWav(channels, sampleRate, 32));
      this.known.add(id);
    }

    async readAudio(id) {
      const file = await (await this.audio.getFileHandle(id + '.wav')).getFile();
      return SS.decodeWav(new Uint8Array(await file.arrayBuffer()));
    }

    async deleteAudio(ids) {
      for (const id of ids) {
        this.known.delete(id);
        try {
          await this.audio.removeEntry(id + '.wav');
        } catch (e) {
          if (e.name !== 'NotFoundError') throw e;
        }
      }
    }

    /** Every song in the folder: { fileName, id, name, savedAt, createdAt, project } */
    async listSongs() {
      const out = [];
      for await (const [name, h] of this.handle.entries()) {
        if (h.kind !== 'file' || !name.endsWith(SONG_EXT)) continue;
        try {
          const d = await readJson(h);
          if (!d || d.format !== 'audabook-song' || typeof d.id !== 'string') continue;
          this.owners.set(name, d.id);
          out.push({ fileName: name, id: d.id, name: d.name, savedAt: +d.savedAt || 0, createdAt: +d.createdAt || 0, project: d.project });
        } catch (e) {
          console.warn('Skipping unreadable song file', name, e);
        }
      }
      return out;
    }

    // "<Song>.song.json", or "<Song> (2).song.json" if another song has that name.
    async freeName(base, id) {
      for (let n = 1; n < 1000; n++) {
        const name = base + (n === 1 ? '' : ' (' + n + ')') + SONG_EXT;
        let owner = this.owners.get(name);
        if (owner === undefined && (await exists(this.handle, name))) {
          try {
            owner = (await readJson(await this.handle.getFileHandle(name))).id;
          } catch (e) {
            owner = '?';
          }
          this.owners.set(name, owner);
        }
        if (owner === undefined || owner === id) return name;
      }
      return base + ' ' + Date.now() + SONG_EXT;
    }

    /** Writes a song's file (renaming it if the song was renamed). song: { id, name, json, savedAt, createdAt, fileName } */
    async writeSong(song) {
      const base = SS.safeFileName(song.name);
      const old = song.fileName;
      const stillFits = old && new RegExp('^' + escapeRe(base) + '( \\(\\d+\\))?' + escapeRe(SONG_EXT) + '$').test(old);
      const fileName = stillFits ? old : await this.freeName(base, song.id);
      await writeFile(this.handle, fileName, JSON.stringify({
        format: 'audabook-song',
        version: 1,
        app: SS.APP_NAME + ' ' + SS.VERSION,
        id: song.id,
        name: song.name,
        savedAt: song.savedAt,
        createdAt: song.createdAt,
        project: JSON.parse(song.json),
      }));
      this.owners.set(fileName, song.id);
      if (old && old !== fileName) await this.removeSongFile(old);
      return fileName;
    }

    async removeSongFile(fileName) {
      this.owners.delete(fileName);
      try {
        await this.handle.removeEntry(fileName);
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
      }
    }

    /** Saves the open song, taking audio straight from memory. sources: Map id -> { channels, rate } */
    async saveOpenSong(song, sources) {
      for (const sid of M.referencedSources(JSON.parse(song.json))) {
        if (await this.hasAudio(sid)) continue;
        const s = sources.get(sid);
        if (s) await this.writeAudio(sid, s.channels, s.rate);
      }
      return this.writeSong(song); // audio first, then the song file that points at it
    }

    /** Copies a song from My Songs to the folder (audio read back from browser storage). */
    async exportSong(id) {
      const rec = await this.store.getSong(id);
      if (!rec) return;
      for (const sid of M.referencedSources(JSON.parse(rec.json))) {
        if (await this.hasAudio(sid)) continue;
        const s = await this.store.getSource(sid);
        if (s) await this.writeAudio(sid, s.channels, s.sampleRate);
      }
      const fileName = await this.writeSong(rec);
      if (fileName !== rec.fileName) await this.store.setSongFileName(id, fileName);
    }

    /** Copies a song from the folder into My Songs. */
    async importSong(r) {
      const project = M.sanitizeProject(r.project);
      for (const id of M.referencedSources(project)) {
        const have = await this.store.getSource(id);
        if (have && have.songId === r.id) continue;
        let wav;
        try {
          wav = await this.readAudio(id);
        } catch (e) {
          console.warn('Audio missing from the songs folder:', id);
          continue;
        }
        await this.store.putSourceRecord({ id, songId: r.id, name: '', sampleRate: wav.sampleRate, length: wav.length, channels: wav.channels });
        this.known.add(id);
      }
      await this.store.putSong(Object.assign({
        id: r.id,
        json: JSON.stringify(project),
        savedAt: r.savedAt,
        createdAt: r.createdAt || r.savedAt,
        fileName: r.fileName,
      }, SS.songSummary(project)));
    }

    /** Deletes a song's file and its audio. */
    async deleteSong(fileName, sourceIds) {
      if (fileName) await this.removeSongFile(fileName);
      await this.deleteAudio(sourceIds);
    }

    /**
     * Brings My Songs and the folder in step: songs only in one place are copied to the other, and where both
     * have a song the newer copy wins. Returns { imported: [ids], exported }.
     */
    async sync(onProgress) {
      const local = await this.store.listSongs();
      const remote = await this.listSongs();
      const localById = new Map(local.map((s) => [s.id, s]));
      const remoteById = new Map(remote.map((s) => [s.id, s]));
      const imported = [];
      let exported = 0;
      for (const r of remote) {
        const l = localById.get(r.id);
        if (l && l.savedAt >= r.savedAt - 1000) continue;
        if (onProgress) onProgress('Bringing in “' + r.name + '”…');
        await this.importSong(r);
        imported.push(r.id);
      }
      for (const l of local) {
        const r = remoteById.get(l.id);
        if (r && r.savedAt >= l.savedAt - 1000) {
          if (l.fileName !== r.fileName) await this.store.setSongFileName(l.id, r.fileName);
          continue;
        }
        if (onProgress) onProgress('Copying “' + l.name + '” to your songs folder…');
        await this.exportSong(l.id);
        exported++;
      }
      return { imported, exported };
    }
  }

  SS.SongsFolder = SongsFolder;
})(window);
