/*
 * store.js -- qDrive local file storage.
 *
 * IndexedDB, with two object stores rather than one:
 *
 *   meta   { id, name, size, mime, created, modified, sha256, origin }
 *   blobs  { id, blob }
 *
 * Splitting them is the important decision. Listing the drive reads `meta`
 * only, so opening the app never pulls file bodies into memory -- with a
 * single store, a cursor over 2 GB of files would try to materialise 2 GB of
 * Blobs just to render their names.
 *
 * Bodies are stored as real Blob objects, never base64 strings. IndexedDB
 * stores Blobs natively and by reference; base64 would inflate every file by a
 * third and force the whole thing through a JS string. (qMS made exactly that
 * mistake with attachments, which is why its message files are 31 MB.)
 */
(function (global) {
  'use strict';

  const DB_NAME = 'qdrive';
  const DB_VERSION = 1;
  const META = 'meta';
  const BLOBS = 'blobs';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) {
          const store = db.createObjectStore(META, { keyPath: 'id' });
          store.createIndex('modified', 'modified');
          // Lets a transfer ask "do I already have this exact content?"
          // without walking every record.
          store.createIndex('sha256', 'sha256');
        }
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open the qDrive database'));
      req.onblocked = () => reject(new Error(
        'qDrive is open in another tab on an older version -- close it and reload.'));
    });
    return dbPromise;
  }

  // Settles on the transaction, not the request: a request can succeed and the
  // transaction still abort (quota being the usual reason), and resolving on
  // the request would report a file as saved that was actually rolled back.
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      let out;
      try {
        out = fn(transaction);
      } catch (e) {
        try { transaction.abort(); } catch (_) { /* already dead */ }
        reject(e);
        return;
      }
      transaction.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ||
        new Error('storage transaction aborted -- the device may be out of space'));
    });
  }

  const req = (request) => ({ __req: request });

  function newId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function sha256Hex(blobOrBuffer) {
    const buffer = blobOrBuffer instanceof Blob
      ? await blobOrBuffer.arrayBuffer()
      : blobOrBuffer;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return (i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)) + ' ' + units[i];
  }

  const Store = {
    async list() {
      const all = await tx([META], 'readonly', (t) => req(t.objectStore(META).getAll()));
      return (all || []).sort((a, b) => (b.modified || 0) - (a.modified || 0));
    },

    async getMeta(id) {
      return tx([META], 'readonly', (t) => req(t.objectStore(META).get(id)));
    },

    async getBlob(id) {
      const record = await tx([BLOBS], 'readonly', (t) => req(t.objectStore(BLOBS).get(id)));
      return record ? record.blob : null;
    },

    // Adds a File (from a picker or a drop) or any Blob with an explicit name.
    //
    // `hidden` starts false: anything you put in the drive is immediately
    // available to your OWN other devices, with no separate "share this"
    // step. Hiding is the opt-OUT. Nothing here is exposed to anyone else --
    // only a device holding this account's key can ever ask for the list.
    async add(fileOrBlob, name, origin) {
      const blob = fileOrBlob;
      const meta = {
        id: newId(),
        name: name || blob.name || 'untitled',
        size: blob.size,
        mime: blob.type || 'application/octet-stream',
        created: Date.now(),
        modified: Date.now(),
        sha256: await sha256Hex(blob),
        origin: origin || 'this device',
        hidden: false,
      };
      // Both stores in ONE transaction, so a failure part-way cannot leave
      // metadata pointing at a body that was never written.
      await tx([META, BLOBS], 'readwrite', (t) => {
        t.objectStore(META).put(meta);
        t.objectStore(BLOBS).put({ id: meta.id, blob: blob });
      });
      return meta;
    },

    async remove(id) {
      await tx([META, BLOBS], 'readwrite', (t) => {
        t.objectStore(META).delete(id);
        t.objectStore(BLOBS).delete(id);
      });
    },

    async rename(id, name) {
      const meta = await Store.getMeta(id);
      if (!meta) throw new Error('That file is no longer here.');
      meta.name = name;
      meta.modified = Date.now();
      await tx([META], 'readwrite', (t) => req(t.objectStore(META).put(meta)));
      return meta;
    },

    // Take a file off the list your other devices can see, or put it back.
    // The file itself is untouched -- this only controls what listShared()
    // reports, which is what a connected device is answered with.
    async setHidden(id, hidden) {
      const meta = await Store.getMeta(id);
      if (!meta) throw new Error('That file is no longer here.');
      meta.hidden = !!hidden;
      await tx([META], 'readwrite', (t) => req(t.objectStore(META).put(meta)));
      return meta;
    },

    // What a connected device is allowed to see. Everything except what has
    // been explicitly hidden.
    //
    // Files predating the hidden flag have no such property; `!m.hidden` reads
    // undefined as visible, which is the right default for them.
    async listShared() {
      return (await Store.list()).filter((m) => !m.hidden);
    },

    async findBySha(sha256) {
      const hits = await tx([META], 'readonly',
        (t) => req(t.objectStore(META).index('sha256').getAll(sha256)));
      return hits && hits.length ? hits[0] : null;
    },

    async totalSize() {
      const all = await Store.list();
      return all.reduce((sum, m) => sum + (m.size || 0), 0);
    },

    // How much room the browser will actually give us. Worth surfacing: a
    // local-first drive that silently hits a quota wall is a bad experience.
    async quota() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
      } catch (e) {
        return null;
      }
    },

    // Asks the browser not to evict this data under storage pressure. Chrome
    // grants it silently when the site is "installed enough"; Firefox prompts.
    // Best-effort by design -- refusal is not an error.
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      try { return await navigator.storage.persist(); } catch (e) { return false; }
    },

    sha256Hex: sha256Hex,
    formatSize: formatSize,
    newId: newId,
  };

  global.QDriveStore = Store;
})(window);
