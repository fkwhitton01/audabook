/* Audabook — autosave. The current song and its audio live in the browser's IndexedDB,
   so closing the tab (or the Chromebook going to sleep) never loses work. */
(function (root) {
  'use strict';
  const SS = root.SS;
  const DB_NAME = 'audabook';

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

  class Store {
    constructor() {
      this.db = null;
    }

    get available() {
      return !!this.db;
    }

    async open() {
      if (!root.indexedDB) return false;
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = root.indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('Storage is busy in another window.'));
        });
        return true;
      } catch (e) {
        console.warn('Autosave is not available:', e);
        this.db = null;
        return false;
      }
    }

    async saveProject(json) {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ json, savedAt: Date.now() }, 'project');
      await complete(tx);
    }

    async loadProject() {
      const tx = this.db.transaction('kv', 'readonly');
      return done(tx.objectStore('kv').get('project'));
    }

    /** src: { id, name, buffer: AudioBuffer } */
    async putSource(src) {
      const channels = [];
      for (let c = 0; c < src.buffer.numberOfChannels; c++) channels.push(src.buffer.getChannelData(c));
      const tx = this.db.transaction('sources', 'readwrite');
      tx.objectStore('sources').put({
        id: src.id,
        name: src.name,
        sampleRate: src.buffer.sampleRate,
        length: src.buffer.length,
        channels,
      });
      await complete(tx);
    }

    async getSource(id) {
      const tx = this.db.transaction('sources', 'readonly');
      return done(tx.objectStore('sources').get(id));
    }

    async sourceIds() {
      const tx = this.db.transaction('sources', 'readonly');
      return done(tx.objectStore('sources').getAllKeys());
    }

    async deleteSources(ids) {
      if (!ids.length) return;
      const tx = this.db.transaction('sources', 'readwrite');
      const store = tx.objectStore('sources');
      for (const id of ids) store.delete(id);
      await complete(tx);
    }

    async clear() {
      const tx = this.db.transaction(['kv', 'sources'], 'readwrite');
      tx.objectStore('kv').clear();
      tx.objectStore('sources').clear();
      await complete(tx);
    }
  }

  SS.Store = Store;
})(window);
