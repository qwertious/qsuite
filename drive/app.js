/*
 * app.js -- qDrive UI.
 *
 * Three states, in order:
 *   1. no account on this device        -> point at /accounts/
 *   2. account present, key locked      -> ask for the password
 *   3. unlocked                         -> the drive itself
 *
 * Step 2 exists because every QRP handshake is signed: without the private key
 * in memory this device cannot prove which account it belongs to, and that
 * proof is the entire access-control mechanism for pairing.
 */
(function (global) {
  'use strict';

  const P2P = global.QSuiteP2P;
  const Store = global.QDriveStore;
  const Transfer = global.QDriveTransfer;

  const state = {
    files: [],
    remoteFiles: null,   // null until a peer sends its listing
    peer: null,
    sharing: false,
    transfers: new Map(), // xfer -> progress record
  };

  const el = {};

  function $(id) { return document.getElementById(id); }

  function cache() {
    ['gateNoAccount', 'gateUnlock', 'gateInsecure', 'insecureMessage', 'driveMain',
     'unlockForm', 'unlockPassword', 'unlockError', 'accountName', 'whoami',
     'fileList', 'fileCount', 'storageLine', 'addBtn', 'fileInput', 'dropZone',
     'shareBtn', 'connectBtn', 'connState', 'remotePanel', 'remoteList', 'remoteCount',
     'transferPanel', 'transferList', 'toast', 'logBox', 'logToggle',
     'codePanel', 'codeToggle', 'makeCodeBtn', 'codeOut', 'codeIn', 'useCodeBtn',
     'replyRow', 'replyIn', 'useReplyBtn']
      .forEach((id) => { el[id] = $(id); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('qs-error', !!isError);
    el.toast.classList.add('qs-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('qs-show'), 3200);
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  /* ------------------------------------------------------------ file list */

  function fileRow(meta, remote) {
    if (remote) {
      return '<li class="qd-file">' +
        '<div class="qd-file-main">' +
          '<span class="qd-file-name">' + escapeHtml(meta.name) + '</span>' +
          '<span class="qd-file-meta">' + Store.formatSize(meta.size) +
            ' · ' + escapeHtml(meta.origin || 'this device') + '</span>' +
        '</div>' +
        '<div class="qd-file-actions">' +
          '<button class="qs-btn" data-get="' + escapeHtml(meta.id) + '">Copy here</button>' +
        '</div>' +
      '</li>';
    }

    const hidden = !!meta.hidden;
    const status = hidden
      ? '<span class="qd-tag qd-tag-hidden">Hidden</span>'
      : '<span class="qd-tag qd-tag-live">Available</span>';

    return '<li class="qd-file' + (hidden ? ' qd-file-hidden' : '') + '">' +
      '<div class="qd-file-main">' +
        '<span class="qd-file-name">' + escapeHtml(meta.name) + '</span>' +
        '<span class="qd-file-meta">' + Store.formatSize(meta.size) +
          ' · ' + escapeHtml(meta.origin || 'this device') + ' · ' + status + '</span>' +
      '</div>' +
      '<div class="qd-file-actions">' +
        '<button class="qs-btn" data-save="' + escapeHtml(meta.id) + '">Save</button>' +
        '<button class="qs-btn" data-hide="' + escapeHtml(meta.id) + '">' +
          (hidden ? 'Unhide' : 'Hide') + '</button>' +
        '<button class="qs-btn qs-btn-danger" data-del="' + escapeHtml(meta.id) + '">Delete</button>' +
      '</div>' +
    '</li>';
  }

  // Whenever what we're offering changes, tell a connected device straight
  // away. Without this, "files appear automatically" would only be true at the
  // moment of connecting -- add a file afterwards and the other side would sit
  // there showing a stale list until it reconnected.
  async function pushListing() {
    if (!state.peer) return;
    try {
      await Transfer.sendListing(state.peer);
    } catch (e) {
      // Not worth interrupting the user: the list refreshes on reconnect.
    }
  }

  async function renderFiles() {
    state.files = await Store.list();
    const visible = state.files.filter((f) => !f.hidden).length;
    const hidden = state.files.length - visible;
    el.fileCount.textContent = state.files.length
      ? visible + ' available to your devices' + (hidden ? ' · ' + hidden + ' hidden' : '')
      : '0 files';

    el.fileList.innerHTML = state.files.length
      ? state.files.map((m) => fileRow(m, false)).join('')
      : '<li class="qs-empty">No files yet. Add some, or copy them from another device.</li>';

    const total = state.files.reduce((sum, m) => sum + (m.size || 0), 0);
    const quota = await Store.quota();
    el.storageLine.textContent = quota && quota.quota
      ? Store.formatSize(total) + ' stored · about ' +
        Store.formatSize(Math.max(0, quota.quota - quota.usage)) + ' free in this browser'
      : Store.formatSize(total) + ' stored on this device';
  }

  function renderRemote() {
    if (!state.remoteFiles) {
      show(el.remotePanel, false);
      return;
    }
    show(el.remotePanel, true);
    el.remoteCount.textContent = state.remoteFiles.length +
      (state.remoteFiles.length === 1 ? ' file' : ' files');
    el.remoteList.innerHTML = state.remoteFiles.length
      ? state.remoteFiles.map((m) => fileRow(m, true)).join('')
      : '<li class="qs-empty">That device has no files yet.</li>';
  }

  /* ------------------------------------------------------------ transfers */

  function renderTransfers() {
    if (!state.transfers.size) {
      show(el.transferPanel, false);
      el.transferList.innerHTML = '';
      return;
    }
    show(el.transferPanel, true);
    el.transferList.innerHTML = Array.from(state.transfers.values()).map((t) => {
      const percent = t.total ? Math.round((t.done / t.total) * 100) : 0;
      const arrow = t.direction === 'down' ? '&#8595;' : '&#8593;';
      return '<li class="qd-xfer' + (t.failed ? ' qd-xfer-failed' : '') + '">' +
        '<div class="qd-xfer-head">' +
          '<span>' + arrow + ' ' + escapeHtml(t.name) + '</span>' +
          '<span class="qs-faint">' + (t.failed ? escapeHtml(t.message)
            : percent + '% · ' + Store.formatSize(t.bytes || 0)) + '</span>' +
        '</div>' +
        '<div class="qd-bar"><div class="qd-bar-fill" style="width:' + percent + '%"></div></div>' +
      '</li>';
    }).join('');
  }

  /* ---------------------------------------------------------- connection */

  function setConnState(text, tone) {
    el.connState.textContent = text;
    el.connState.className = 'qd-conn ' + (tone || '');
  }

  function onPeerConnected(peer) {
    state.peer = peer;
    setConnState('Connected to your other device', 'qd-ok');
    el.connectBtn.disabled = true;
    Transfer.requestListing(peer);
    renderFiles();
    toast('Connected');
  }

  function onPeerDisconnected() {
    state.peer = null;
    state.remoteFiles = null;
    setConnState('Not connected', '');
    el.connectBtn.disabled = false;
    renderRemote();
    renderFiles();
  }

  /* --------------------------------------------------------------- gates */

  async function showGate() {
    const problem = P2P.secureContextProblem();
    if (problem) {
      el.insecureMessage.textContent = problem;
      show(el.gateInsecure, true);
      return;
    }

    const account = P2P.detectAccount();
    if (!account) {
      show(el.gateNoAccount, true);
      return;
    }

    const username = account.chain ? await P2P.usernameFor(account.chain) : null;
    el.accountName.textContent = username || account.uuid.slice(0, 8) + '...';
    show(el.gateUnlock, true);
    el.unlockPassword.focus();
  }

  async function doUnlock(event) {
    event.preventDefault();
    el.unlockError.textContent = '';
    const button = el.unlockForm.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const identity = await P2P.unlock(el.unlockPassword.value);
      el.unlockPassword.value = '';
      show(el.gateUnlock, false);
      show(el.driveMain, true);
      el.whoami.textContent = identity.username;
      await renderFiles();
      // Ask to keep this data through storage pressure. Best effort -- some
      // browsers grant silently, some prompt, some refuse.
      Store.persist();
      // Start sharing straight away rather than making the user ask for it.
      // Being listed only exposes this account's uuid and a device label, and
      // only a device holding this account's key can connect -- so the useful
      // default is on, with per-file Hide as the way to hold something back.
      autoShare();
    } catch (e) {
      el.unlockError.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }

  // Turns sharing on without user action. Failing is fine and expected when
  // no node is reachable -- it just means the manual code path is needed, so
  // this reports quietly in the status line rather than as an error.
  async function autoShare() {
    try {
      await P2P.startSharing({ deviceName: navigator.platform || 'A device' });
      state.sharing = true;
      el.shareBtn.textContent = 'Stop sharing this device';
      setConnState('Your files are available to your other devices', 'qd-ok');
    } catch (e) {
      state.sharing = false;
      el.shareBtn.textContent = 'Share this device';
      setConnState('Not shared — ' + e.message, '');
    }
  }

  /* -------------------------------------------------------------- events */

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      try {
        await Store.add(file, file.name, 'this device');
        added++;
      } catch (e) {
        toast('Could not add ' + file.name + ': ' + e.message, true);
      }
    }
    if (added) {
      await renderFiles();
      await pushListing();
      toast(added === 1
        ? 'Added 1 file — available to your devices'
        : 'Added ' + added + ' files — available to your devices');
    }
  }

  async function saveToDisk(id) {
    const meta = await Store.getMeta(id);
    const blob = await Store.getBlob(id);
    if (!meta || !blob) { toast('That file is no longer here', true); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function wire() {
    el.unlockForm.addEventListener('submit', doUnlock);

    el.addBtn.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach((type) => {
      el.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        el.dropZone.classList.add('qd-drag');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      el.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'drop') addFiles(event.dataTransfer.files);
        el.dropZone.classList.remove('qd-drag');
      });
    });

    el.fileList.addEventListener('click', async (event) => {
      const save = event.target.closest('[data-save]');
      const del = event.target.closest('[data-del]');
      const hide = event.target.closest('[data-hide]');

      if (save) return saveToDisk(save.getAttribute('data-save'));

      if (hide) {
        const id = hide.getAttribute('data-hide');
        const meta = state.files.find((f) => f.id === id);
        if (!meta) return;
        await Store.setHidden(id, !meta.hidden);
        await renderFiles();
        await pushListing();
        toast(meta.hidden
          ? '"' + meta.name + '" is available to your devices again'
          : '"' + meta.name + '" is hidden from your other devices');
        return;
      }

      if (del) {
        const id = del.getAttribute('data-del');
        const meta = state.files.find((f) => f.id === id);
        if (meta && confirm('Delete "' + meta.name + '" from this device?')) {
          await Store.remove(id);
          await renderFiles();
          await pushListing();
          toast('Deleted');
        }
      }
    });

    el.remoteList.addEventListener('click', (event) => {
      const get = event.target.closest('[data-get]');
      if (!get || !state.peer || !state.remoteFiles) return;
      const meta = state.remoteFiles.find((f) => f.id === get.getAttribute('data-get'));
      if (meta) {
        Transfer.requestFile(state.peer, meta);
        toast('Copying ' + meta.name);
      }
    });

    el.shareBtn.addEventListener('click', async () => {
      el.shareBtn.disabled = true;
      try {
        if (state.sharing) {
          P2P.stopSharing();
          state.sharing = false;
          el.shareBtn.textContent = 'Share this device';
          setConnState(state.peer ? 'Connected to your other device' : 'Not shared', '');
        } else {
          await autoShare();
        }
      } catch (e) {
        toast(e.message, true);
      } finally {
        el.shareBtn.disabled = false;
      }
    });

    el.connectBtn.addEventListener('click', async () => {
      el.connectBtn.disabled = true;
      setConnState('Looking for your other device...', 'qd-wait');
      try {
        await P2P.connectToMyDevice();
      } catch (e) {
        setConnState('Not connected', '');
        el.connectBtn.disabled = false;
        toast(e.message, true);
      }
    });

    el.logToggle.addEventListener('click', () => {
      el.logBox.hidden = !el.logBox.hidden;
      el.logToggle.textContent = el.logBox.hidden ? 'Show connection log' : 'Hide connection log';
    });

    el.codeToggle.addEventListener('click', () => {
      el.codePanel.hidden = !el.codePanel.hidden;
    });

    el.makeCodeBtn.addEventListener('click', async () => {
      try {
        el.codeOut.value = 'working...';
        el.codeOut.value = await P2P.createConnectionCode();
        show(el.replyRow, true);
        el.codeOut.select();
      } catch (e) {
        el.codeOut.value = '';
        toast(e.message, true);
      }
    });

    el.useCodeBtn.addEventListener('click', async () => {
      try {
        const reply = await P2P.acceptConnectionCode(el.codeIn.value);
        el.codeOut.value = reply;
        show(el.replyRow, false);
        toast('Now send that reply code back');
        el.codeOut.select();
      } catch (e) {
        toast(e.message, true);
      }
    });

    el.useReplyBtn.addEventListener('click', async () => {
      try {
        await P2P.completeWithReplyCode(el.replyIn.value);
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  function wireP2P() {
    P2P.on('log', (line) => {
      const entry = document.createElement('div');
      entry.textContent = line;
      el.logBox.appendChild(entry);
      el.logBox.scrollTop = el.logBox.scrollHeight;
    });

    P2P.on('peer', (event, peer) => {
      if (event === 'connected') onPeerConnected(peer);
      else onPeerDisconnected();
    });

    Transfer.on('listing', (peer, files) => {
      state.remoteFiles = files;
      renderRemote();
    });

    Transfer.on('progress', (p) => {
      state.transfers.set(p.xfer, {
        xfer: p.xfer, direction: p.direction, name: p.meta ? p.meta.name : 'file',
        done: p.done, total: p.total, bytes: p.bytes, size: p.size,
      });
      renderTransfers();
    });

    Transfer.on('complete', async (c) => {
      state.transfers.delete(c.xfer);
      renderTransfers();
      if (c.direction === 'up') {
        toast('Sent ' + c.meta.name);
        return; // nothing changed in OUR drive, so no re-render needed
      }
      await renderFiles();
      toast('Copied ' + c.meta.name);
    });

    Transfer.on('error', (e) => {
      const existing = state.transfers.get(e.xfer);
      if (existing) {
        existing.failed = true;
        existing.message = e.message;
        renderTransfers();
        setTimeout(() => { state.transfers.delete(e.xfer); renderTransfers(); }, 8000);
      }
      toast(e.message, true);
    });

    Transfer.attach();
  }

  async function init() {
    cache();
    wire();
    wireP2P();
    await showGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.QDriveApp = { state: state, renderFiles: renderFiles };
})(window);
