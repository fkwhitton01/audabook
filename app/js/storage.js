/* Audabook — the song library. Every song and its audio live in the browser's IndexedDB, so closing the app
   (or the Chromebook going to sleep) never loses work, and starting a new song keeps all the old ones.

   Stores:  songs    { id, name, json (the project), savedAt, createdAt, duration, trackCount }
            sources  { id, songId, name, sampleRate, length, channels: Float32Array[] }   (index: bySong)
            kv       'currentSong' -> the song that was open last; 'songsFolder' -> the folder that keeps copies */
(function (root) {
  'use strict';
  const SS = root.SS;
  const M = SS.model;
  const DB_NAME = 'audabook';
  const DB_VERSION = 2;

  function done(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function complete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Saving was interrupted.'));
    });
  }

  // The facts the My Songs list shows, so listing songs never has to load any audio.
  SS.songSummary = function (project) {
    try {
      const p = typeof project === 'string' ? JSON.parse(project) : project;
      return {
        name: typeof p.name === 'string' && p.name ? p.name : 'My Song',
        duration: M.projectEnd(p),
        trackCount: Array.isArray(p.tracks) ? p.tracks.length : 0,
      };
    } catch (e) {
      return { name: 'My Song', duration: 0, trackCount: 0 };
    }
  };

  // Version 1 kept a single song. Move it into the song list, untouched, so nothing is lost by updating.
  function upgrade(db, tx, oldVersion) {
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    const sources = db.objectStoreNames.contains('sources')
      ? tx.objectStore('sources')
      : db.createObjectStore('sources', { keyPath: 'id' });
    if (!sources.indexNames.contains('bySong')) sources.createIndex('bySong', 'songId');
    if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
    if (oldVersion !== 1) return;
    const kv = tx.objectStore('kv');
    kv.get('project').onsuccess = (e) => {
      const old = e.target.result;
      if (!old || !old.json) return;
      const id = SS.uid('song');
      const when = old.savedAt || Date.now();
      tx.objectStore('songs').put(Object.assign({ id, json: old.json, savedAt: when, createdAt: when }, SS.songSummary(old.json)));
      kv.put(id, 'currentSong');
      kv.delete('project');
      sources.openCursor().onsuccess = (ce) => {
        const cursor = ce.target.result;
        if (!cursor) return;
        const rec = cursor.value;
        rec.songId = id;
        cursor.update(rec);
        cursor.continue();
      };
    };
  }

  class Store {
    constructor() {
      this.db = null;
      this.onBlocked = null; // another window is holding the old version open
    }

    get available() {
      return !!this.db;
    }

    async open() {
      if (!root.indexedDB) return false;
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = root.indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = (e) => upgrade(req.result, req.transaction, e.oldVersion);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          // Opening waits until the other window lets go; say so instead of failing.
          req.onblocked = () => {
            if (this.onBlocked) this.onBlocked();
          };
        });
        // A newer Audabook in another window needs to upgrade: step aside rather than block it.
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
        };
        return true;
      } catch (e) {
        console.warn('Saving songs is not available:', e);
        this.db = null;
        return false;
      }
    }

    /** All songs without their contents, most recently edited first. */
    async listSongs() {
      const tx = this.db.transaction('songs', 'readonly');
      const all = await done(tx.objectStore('songs').getAll());
      return all
        .map((s) => ({
          id: s.id, name: s.name, savedAt: s.savedAt, createdAt: s.createdAt,
          duration: s.duration, trackCount: s.trackCount, fileName: s.fileName,
        }))
        .sort((a, b) => b.savedAt - a.savedAt);
    }

    /** Stores a song without making it the one to reopen (used when songs come in from the songs folder). */
    async putSong(song) {
      const tx = this.db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      await complete(tx);
    }

    // Remembers which file in the songs folder holds this song.
    async setSongFileName(id, fileName) {
      const tx = this.db.transaction('songs', 'readwrite');
      const store = tx.objectStore('songs');
      const song = await done(store.get(id));
      if (song && song.fileName !== fileName) {
        song.fileName = fileName;
        store.put(song);
      }
      await complete(tx);
    }

    /** The songs folder: { handle (FileSystemDirectoryHandle), label } */
    async getFolder() {
      const tx = this.db.transaction('kv', 'readonly');
      return done(tx.objectStore('kv').get('songsFolder'));
    }

    async setFolder(folder) {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(folder, 'songsFolder');
      await complete(tx);
    }

    async getSong(id) {
      const tx = this.db.transaction('songs', 'readonly');
      return done(tx.objectStore('songs').get(id));
    }

    /** Saves a song and remembers it as the one to reopen next time. */
    async saveSong(song) {
      const tx = this.db.transaction(['songs', 'kv'], 'readwrite');
      tx.objectStore('songs').put(song);
      tx.objectStore('kv').put(song.id, 'currentSong');
      await complete(tx);
    }

    async getCurrentSongId() {
      const tx = this.db.transaction('kv', 'readonly');
      return done(tx.objectStore('kv').get('currentSong'));
    }

    async setCurrentSongId(id) {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(id, 'currentSong');
      await complete(tx);
    }

    async renameSong(id, name) {
      const tx = this.db.transaction('songs', 'readwrite');
      const store = tx.objectStore('songs');
      const song = await done(store.get(id));
      if (song) {
        try {
          const p = JSON.parse(song.json);
          p.name = name;
          song.json = JSON.stringify(p);
        } catch (e) { /* keep the old contents */ }
        song.name = name;
        store.put(song);
      }
      await complete(tx);
    }

    /** Deletes a song and all of its audio. */
    async deleteSong(id) {
      const tx = this.db.transaction(['songs', 'sources', 'kv'], 'readwrite');
      tx.objectStore('songs').delete(id);
      const sources = tx.objectStore('sources');
      sources.index('bySong').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        sources.delete(cursor.primaryKey);
        cursor.continue();
      };
      const kv = tx.objectStore('kv');
      kv.get('currentSong').onsuccess = (e) => {
        if (e.target.result === id) kv.delete('currentSong');
      };
      await complete(tx);
    }

    /** src: { id, name, buffer: AudioBuffer } */
    async putSource(src, songId) {
      const channels = [];
      for (let c = 0; c < src.buffer.numberOfChannels; c++) channels.push(src.buffer.getChannelData(c));
      const tx = this.db.transaction('sources', 'readwrite');
      tx.objectStore('sources').put({
        id: src.id,
        songId,
        name: src.name,
        sampleRate: src.buffer.sampleRate,
        length: src.buffer.length,
        channels,
      });
      await complete(tx);
    }

    /** A source record as stored: { id, songId, name, sampleRate, length, channels } */
    async putSourceRecord(rec) {
      const tx = this.db.transaction('sources', 'readwrite');
      tx.objectStore('sources').put(rec);
      await complete(tx);
    }

    async getSource(id) {
      const tx = this.db.transaction('sources', 'readonly');
      return done(tx.objectStore('sources').get(id));
    }

    async sourceIdsForSong(songId) {
      const tx = this.db.transaction('sources', 'readonly');
      return done(tx.objectStore('sources').index('bySong').getAllKeys(IDBKeyRange.only(songId)));
    }

    async deleteSources(ids) {
      if (!ids.length) return;
      const tx = this.db.transaction('sources', 'readwrite');
      const store = tx.objectStore('sources');
      for (const id of ids) store.delete(id);
      await complete(tx);
    }

    /** Removes audio left behind by songs that were never saved (e.g. the tab closed mid-take). */
    async deleteOrphanSources(keepSongIds) {
      const tx = this.db.transaction('sources', 'readwrite');
      const store = tx.objectStore('sources');
      store.index('bySong').openKeyCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (!keepSongIds.has(cursor.key)) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      await complete(tx);
    }
  }

  SS.Store = Store;
})(window);
