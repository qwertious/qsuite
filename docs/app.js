/*
 * app.js -- qDocs UI: document list, search, editor, export.
 *
 * The editor is a contenteditable driven by document.execCommand. That API is
 * formally deprecated and its replacement (the EditContext API) is not yet
 * broadly available, so for a small local editor it remains the option that
 * works in every browser today with no dependencies. The document model is
 * plain HTML, which is also what every export format walks -- so nothing is
 * lost by keeping it.
 */
(function (global) {
  'use strict';

  const Store = global.QDocsStore;
  const Export = global.QDocsExport;

  const AUTOSAVE_MS = 600;

  const state = {
    docs: [],         // every document, newest first
    currentId: null,
    query: '',
    dirty: false,
    saveTimer: null,
  };

  const el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    ['docList', 'searchInput', 'searchClear', 'newDocBtn', 'editor', 'titleInput',
     'docMeta', 'exportSelect', 'exportBtn', 'deleteBtn', 'emptyState', 'editorPane',
     'toast', 'sidebar', 'sidebarScrim', 'menuBtn', 'themeBtn', 'docCount',
     'driveFormat', 'driveSaveBtn', 'driveOpenBtn', 'drivePicker', 'drivePickerList',
     'drivePickerClose']
      .forEach((id) => { el[id] = $(id); });
  }

  /* ------------------------------------------------------------- toasts */

  let toastTimer = null;
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('qs-error', !!isError);
    el.toast.classList.add('qs-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('qs-show'), 2400);
  }

  /* -------------------------------------------------------- document list */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Wraps each search term where it appears. Escaping happens first, then the
  // marks are inserted -- doing it the other way round would let a document
  // whose text contains "<mark>" inject markup into the list.
  function highlight(text, query) {
    const safe = escapeHtml(text);
    const terms = String(query || '').split(/\s+/).filter(Boolean);
    if (!terms.length) return safe;
    const pattern = terms
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length)
      .join('|');
    return safe.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    const hours = Math.round(min / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(ts).toLocaleDateString();
  }

  function renderList() {
    const results = Store.search(state.docs, state.query);

    el.docCount.textContent = state.query
      ? results.length + ' of ' + state.docs.length
      : state.docs.length + (state.docs.length === 1 ? ' document' : ' documents');

    if (!results.length) {
      el.docList.innerHTML = '<li class="qs-empty">' +
        (state.query ? 'No documents match that search.' : 'No documents yet.') +
        '</li>';
      return;
    }

    el.docList.innerHTML = results.map(({ doc, snippet }) => {
      const active = doc.id === state.currentId ? ' qd-active' : '';
      return '<li>' +
        '<button type="button" class="qd-doc-item' + active + '" data-id="' +
        escapeHtml(doc.id) + '">' +
        '<span class="qd-doc-title">' + highlight(doc.title, state.query) + '</span>' +
        '<span class="qd-doc-time">' + escapeHtml(relativeTime(doc.modified)) + '</span>' +
        (snippet ? '<span class="qd-doc-snippet">' + highlight(snippet, state.query) +
          '</span>' : '') +
        '</button></li>';
    }).join('');
  }

  /* ------------------------------------------------------------- editor */

  function currentDoc() {
    return state.docs.find((d) => d.id === state.currentId) || null;
  }

  function showEditor(show) {
    el.editorPane.hidden = !show;
    el.emptyState.hidden = show;
  }

  function openDoc(id) {
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    // Flush any pending edits to the document we're leaving, or switching fast
    // discards the last few keystrokes.
    if (state.dirty) saveNow();

    state.currentId = id;
    el.titleInput.value = doc.title === 'Untitled document' ? '' : doc.title;
    el.editor.innerHTML = doc.body || '';
    el.docMeta.textContent = 'Created ' + new Date(doc.created).toLocaleDateString() +
      ' · edited ' + relativeTime(doc.modified);
    showEditor(true);
    renderList();
    closeSidebar();
  }

  function scheduleSave() {
    state.dirty = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
  }

  async function saveNow() {
    clearTimeout(state.saveTimer);
    if (!state.dirty) return;
    const doc = currentDoc();
    if (!doc) { state.dirty = false; return; }

    const body = el.editor.innerHTML;
    const plain = Store.htmlToPlain(body);
    const typed = el.titleInput.value.trim();

    doc.body = body;
    doc.plain = plain;
    doc.title = typed || Store.deriveTitle(plain);

    state.dirty = false;
    try {
      const saved = await Store.put(doc);
      Object.assign(doc, saved);
      // Keep the list ordered by recency without a round trip to the database.
      state.docs.sort((a, b) => b.modified - a.modified);
      renderList();
      el.docMeta.textContent = 'Created ' +
        new Date(doc.created).toLocaleDateString() + ' · saved just now';
    } catch (e) {
      state.dirty = true; // let the next tick try again rather than lose it
      toast('Could not save: ' + e.message, true);
    }
  }

  async function newDoc() {
    if (state.dirty) await saveNow();
    try {
      const doc = await Store.create({});
      state.docs.unshift(doc);
      // A new empty document would be filtered out by an active search, so
      // clear it -- otherwise the document appears to not have been created.
      state.query = '';
      el.searchInput.value = '';
      openDoc(doc.id);
      el.titleInput.focus();
    } catch (e) {
      toast('Could not create document: ' + e.message, true);
    }
  }

  async function deleteCurrent() {
    const doc = currentDoc();
    if (!doc) return;
    const ok = global.confirm('Delete "' + doc.title + '"?\n\nThis cannot be undone.');
    if (!ok) return;
    try {
      await Store.remove(doc.id);
      state.docs = state.docs.filter((d) => d.id !== doc.id);
      state.currentId = null;
      state.dirty = false;
      showEditor(false);
      renderList();
      toast('Document deleted');
    } catch (e) {
      toast('Could not delete: ' + e.message, true);
    }
  }

  async function doExport() {
    if (state.dirty) await saveNow();
    const doc = currentDoc();
    if (!doc) return;
    const format = el.exportSelect.value;
    try {
      Export.run(doc, format);
      if (format !== 'pdf') toast('Exported as .' + format);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* -------------------------------------------------------------- qDrive */
  // qDocs and qDrive are separate IndexedDB databases on the same origin, so
  // qDocs can write into the drive directly by reusing its store module -- no
  // duplicated storage code, and no account needed: only *transferring* a file
  // between devices requires signing in, not putting one in the drive.

  const Drive = global.QDriveStore || null;

  async function saveToDrive() {
    if (!Drive) { toast('qDrive is not available on this page', true); return; }
    if (state.dirty) await saveNow();
    const doc = currentDoc();
    if (!doc) return;

    // .html by default: it is the only format that round-trips losslessly,
    // because toStandaloneHtml embeds the document as JSON inside the page.
    const format = el.driveFormat.value;
    try {
      const { blob, filename } = Export.toBlob(doc, format);
      await Drive.add(blob, filename, 'qDocs');
      toast('Saved "' + filename + '" to qDrive');
    } catch (e) {
      toast('Could not save to qDrive: ' + e.message, true);
    }
  }

  // Only offer files qDocs can actually make sense of.
  function importable(meta) {
    return /\.(html?|md|markdown|txt)$/i.test(meta.name || '');
  }

  async function openDrivePicker() {
    if (!Drive) { toast('qDrive is not available on this page', true); return; }
    let files = [];
    try {
      files = (await Drive.list()).filter(importable);
    } catch (e) {
      toast('Could not read qDrive: ' + e.message, true);
      return;
    }

    el.drivePickerList.innerHTML = files.length
      ? files.map((f) => '<li><button type="button" class="qd-doc-item" data-drive="' +
          escapeHtml(f.id) + '">' +
          '<span class="qd-doc-title">' + escapeHtml(f.name) + '</span>' +
          '<span class="qd-doc-time">' + Drive.formatSize(f.size) + ' · from ' +
          escapeHtml(f.origin || 'this device') + '</span></button></li>').join('')
      : '<li class="qs-empty">No documents in qDrive yet. Save one there first, ' +
        'or copy one across from another device.</li>';

    el.drivePicker.hidden = false;
  }

  async function importFromDrive(id) {
    const meta = await Drive.getMeta(id);
    const blob = await Drive.getBlob(id);
    if (!meta || !blob) { toast('That file is no longer in qDrive', true); return; }

    const text = await blob.text();
    let fields;
    if (/\.html?$/i.test(meta.name)) {
      const parsed = Export.parseQDocsHtml(text);
      fields = { title: parsed.title, body: parsed.body, lossless: parsed.lossless };
    } else {
      // Markdown and plain text both come in as text. Rather than ship a
      // Markdown parser, keep the source readable: paragraphs split on blank
      // lines, everything else left as typed.
      const paragraphs = text.split(/\n{2,}/).map((block) => {
        const safe = block.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        return '<p>' + safe.replace(/\n/g, '<br>') + '</p>';
      });
      fields = {
        title: meta.name.replace(/\.[^.]+$/, ''),
        body: paragraphs.join('\n'),
        lossless: false,
      };
    }

    const plain = Store.htmlToPlain(fields.body);
    const created = await Store.create({
      title: fields.title || Store.deriveTitle(plain),
      body: fields.body,
      plain: plain,
    });

    state.docs.unshift(created);
    state.query = '';
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    el.drivePicker.hidden = true;
    openDoc(created.id);
    toast(fields.lossless ? 'Opened from qDrive' : 'Imported from qDrive (formatting simplified)');
  }

  /* --------------------------------------------------------- formatting */

  function applyFormat(command, value) {
    el.editor.focus();
    try {
      document.execCommand(command, false, value || null);
    } catch (e) {
      toast('That formatting is not supported here', true);
    }
    scheduleSave();
  }

  function wireToolbar() {
    document.querySelectorAll('[data-cmd]').forEach((button) => {
      button.addEventListener('click', () => {
        const cmd = button.getAttribute('data-cmd');
        if (cmd === 'createLink') {
          const url = global.prompt('Link URL:', 'https://');
          if (url) applyFormat('createLink', url);
          return;
        }
        applyFormat(cmd, button.getAttribute('data-value'));
      });
    });
  }

  /* ------------------------------------------------------------ sidebar */

  function openSidebar() {
    el.sidebar.classList.add('qs-open');
    el.sidebarScrim.hidden = false;
  }

  function closeSidebar() {
    el.sidebar.classList.remove('qs-open');
    el.sidebarScrim.hidden = true;
  }

  /* -------------------------------------------------------------- theme */

  function applyTheme(theme) {
    document.documentElement.classList.toggle('qs-light', theme === 'light');
    el.themeBtn.textContent = theme === 'light' ? '☽' : '☀';
    el.themeBtn.setAttribute('aria-label',
      theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    try { localStorage.setItem('qdocs.theme', theme); } catch (e) { /* private mode */ }
  }

  function initTheme() {
    let theme = null;
    try { theme = localStorage.getItem('qdocs.theme'); } catch (e) { /* ignore */ }
    if (!theme) {
      theme = global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    applyTheme(theme);
  }

  /* --------------------------------------------------------------- wire */

  function wireEvents() {
    el.newDocBtn.addEventListener('click', newDoc);
    el.deleteBtn.addEventListener('click', deleteCurrent);
    el.exportBtn.addEventListener('click', doExport);

    el.editor.addEventListener('input', scheduleSave);
    el.titleInput.addEventListener('input', scheduleSave);

    el.searchInput.addEventListener('input', () => {
      state.query = el.searchInput.value.trim();
      el.searchClear.hidden = !state.query;
      renderList();
    });
    el.searchClear.addEventListener('click', () => {
      el.searchInput.value = '';
      state.query = '';
      el.searchClear.hidden = true;
      renderList();
      el.searchInput.focus();
    });

    // Delegated so the list can be re-rendered freely without rebinding.
    el.docList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-id]');
      if (item) openDoc(item.getAttribute('data-id'));
    });

    el.menuBtn.addEventListener('click', openSidebar);
    el.sidebarScrim.addEventListener('click', closeSidebar);

    el.driveSaveBtn.addEventListener('click', saveToDrive);
    el.driveOpenBtn.addEventListener('click', openDrivePicker);
    el.drivePickerClose.addEventListener('click', () => { el.drivePicker.hidden = true; });
    el.drivePicker.addEventListener('click', (event) => {
      // Clicking the backdrop (but not the card) dismisses it.
      if (event.target === el.drivePicker) { el.drivePicker.hidden = true; return; }
      const pick = event.target.closest('[data-drive]');
      if (pick) importFromDrive(pick.getAttribute('data-drive'));
    });

    el.themeBtn.addEventListener('click', () => {
      const isLight = document.documentElement.classList.contains('qs-light');
      applyTheme(isLight ? 'dark' : 'light');
    });

    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === 's') { event.preventDefault(); saveNow(); toast('Saved'); }
      if (mod && event.key === 'k') { event.preventDefault(); el.searchInput.focus(); }
      if (mod && event.key === 'b') { event.preventDefault(); applyFormat('bold'); }
      if (mod && event.key === 'i') { event.preventDefault(); applyFormat('italic'); }
      if (event.key === 'Escape') {
        closeSidebar();
        if (el.drivePicker) el.drivePicker.hidden = true;
      }
    });

    // Last line of defence for the debounce window: if the tab is closing or
    // being backgrounded with unsaved keystrokes, write them out now.
    // visibilitychange is the reliable one on mobile, where pagehide/unload
    // often never fire.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.dirty) saveNow();
    });
    global.addEventListener('pagehide', () => { if (state.dirty) saveNow(); });
  }

  async function init() {
    cacheElements();
    initTheme();
    wireToolbar();
    wireEvents();

    el.exportSelect.innerHTML = Export.formats
      .map((f) => '<option value="' + f.id + '">' + escapeHtml(f.label) + '</option>')
      .join('');

    try {
      state.docs = await Store.all();
    } catch (e) {
      el.docList.innerHTML = '<li class="qs-empty">Could not open local storage: ' +
        escapeHtml(e.message) + '</li>';
      return;
    }

    renderList();
    if (state.docs.length) openDoc(state.docs[0].id);
    else showEditor(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed for the self-test page.
  global.QDocsApp = { state: state, saveNow: saveNow, renderList: renderList };
})(window);
