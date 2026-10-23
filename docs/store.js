/*
 * store.js -- qDocs persistence. IndexedDB, entirely on this device.
 *
 * IndexedDB rather than localStorage because documents are unbounded in size
 * and localStorage is a synchronous ~5 MB string store -- one long document
 * with a pasted image would blow it, and every save would block the editor.
 *
 * A document is:
 *   { id, title, body, plain, created, modified }
 * where `body` is the editor's HTML and `plain` is its text content, kept
 * alongside purely so search doesn't have to parse HTML for every document on
 * every keystroke.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'qdocs';
  const DB_VERSION = 1;
  const STORE = 'documents';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          // Sorting the document list by recency is the only query this app
          // makes often enough to deserve an index.
          store.createIndex('modified', 'modified');
        }
        void event;
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open qDocs database'));
      req.onblocked = () => reject(new Error(
        'qDocs is open in another tab running a different version -- close it and reload.'));
    });
    return dbPromise;
  }

  // Wraps one transaction in a promise that settles on the TRANSACTION, not on
  // the request. A request can succeed and the transaction still abort (quota,
  // for one), and resolving early would report a save that never landed.
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (e) {
        transaction.abort();
        reject(e);
        return;
      }
      transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
    });
  }

  function req(request) {
    return { __req: request };
  }

  function newId() {
    // Time-prefixed so ids sort chronologically, with randomness for
    // uniqueness. Fixed width keeps string comparison meaningful.
    return Date.now().toString(36).padStart(9, '0') + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  // Derives the searchable plain text from editor HTML. Block elements become
  // line breaks so words either side of a paragraph boundary don't fuse into
  // one false match ("end" + "Start" -> "endStart").
  function htmlToPlain(html) {
    const el = document.createElement('div');
    el.innerHTML = html || '';
    el.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    el.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr, pre')
      .forEach((node) => node.append('\n'));
    return (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // First non-empty line of the body, used when the user hasn't named the
  // document -- the same affordance most editors give.
  function deriveTitle(plain) {
    const first = (plain || '').split('\n').map((s) => s.trim()).find(Boolean);
    if (!first) return 'Untitled document';
    return first.length > 80 ? first.slice(0, 80) + '...' : first;
  }

  const Store = {
    async all() {
      const list = await tx('readonly', (store) => req(store.getAll()));
      return (list || []).sort((a, b) => (b.modified || 0) - (a.modified || 0));
    },

    async get(id) {
      return tx('readonly', (store) => req(store.get(id)));
    },

    async create(fields) {
      const now = Date.now();
      const doc = Object.assign({
        id: newId(),
        title: '',
        body: '',
        plain: '',
        created: now,
        modified: now,
      }, fields || {});
      if (!doc.title) doc.title = 'Untitled document';
      await tx('readwrite', (store) => req(store.add(doc)));
      return doc;
    },

    // Full replace, not a merge -- callers always hold the whole document.
    async put(doc) {
      const next = Object.assign({}, doc, { modified: Date.now() });
      await tx('readwrite', (store) => req(store.put(next)));
      return next;
    },

    async remove(id) {
      await tx('readwrite', (store) => req(store.delete(id)));
    },

    async count() {
      return tx('readonly', (store) => req(store.count()));
    },

    htmlToPlain: htmlToPlain,
    deriveTitle: deriveTitle,
    newId: newId,
  };

  /* -------------------------------------------------------------- search */

  // Case-insensitive AND-search over title and body: a document matches when
  // it contains every term, anywhere. A linear scan is genuinely the right
  // choice at this scale -- an inverted index would cost more to keep correct
  // than it saves until there are thousands of documents, and it can be added
  // later without changing this signature.
  //
  // Returns [{doc, snippet, titleMatch}], most recently modified first.
  Store.search = function (docs, query) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      return docs.map((doc) => ({ doc: doc, snippet: '', titleMatch: false }));
    }

    const results = [];
    for (const doc of docs) {
      const title = (doc.title || '').toLowerCase();
      const plain = (doc.plain || '').toLowerCase();
      if (!terms.every((t) => title.includes(t) || plain.includes(t))) continue;

      // Build the snippet around the first term that actually appears in the
      // body; a title-only match has nothing useful to excerpt.
      let snippet = '';
      for (const term of terms) {
        const at = plain.indexOf(term);
        if (at !== -1) {
          const from = Math.max(0, at - 40);
          const to = Math.min(doc.plain.length, at + term.length + 60);
          snippet = (from > 0 ? '...' : '') +
            doc.plain.slice(from, to).replace(/\s+/g, ' ').trim() +
            (to < doc.plain.length ? '...' : '');
          break;
        }
      }
      results.push({
        doc: doc,
        snippet: snippet,
        titleMatch: terms.some((t) => title.includes(t)),
      });
    }
    return results;
  };

  global.QDocsStore = Store;
})(window);
