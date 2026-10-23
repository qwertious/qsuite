/*
 * transfer.js -- moving files over a qSuite peer connection.
 *
 * The connection underneath is ordered and reliable (an ordered RTCDataChannel,
 * or a WebSocket via the relay), so this layer does NOT need acknowledgements,
 * retransmission or reordering. What it does need, and what none of the lower
 * layers provide, is:
 *
 *   - chunking. Nothing in the stack caps message size, but SCTP does: sends
 *     much above ~64 KiB are unreliable across browsers, and the QNP relay
 *     refuses frames over 1 MiB outright (and does not reassemble fragments).
 *     CHUNK_BYTES is set well under both.
 *   - backpressure, which lives in qsuite-p2p.js's sendFrame -- without it a
 *     large file simply overruns the send buffer and kills the channel.
 *   - integrity. Every transfer ends with the sender's SHA-256, and the
 *     receiver recomputes it over what actually arrived before committing.
 *     A file that does not match is discarded rather than silently stored.
 *   - resumption. The receiver keeps its partial chunk list, so a dropped
 *     connection can restart from the first missing chunk instead of byte zero.
 *
 * Protocol (JSON control frames, binary data frames):
 *
 *   -> {t:'list'}                          "what do you have?"
 *   <- {t:'listing', files:[meta,...]}
 *   -> {t:'get', xfer, id, fromChunk}      "send me this, starting here"
 *   <- {t:'begin', xfer, meta, chunks}
 *   <- [binary: xfer, index, payload] x N
 *   <- {t:'end', xfer}
 *   <- {t:'error', xfer, message}
 *
 * Sending a file the other way round is the same exchange initiated by the
 * other side, so one connection serves both directions.
 */
(function (global) {
  'use strict';

  const P2P = global.QSuiteP2P;
  const Store = global.QDriveStore;

  // 16 KiB. Comfortably under the ~64 KiB cross-browser SCTP-safe ceiling
  // even after the 9-byte header and QRP's 24 bytes of AEAD overhead, and two
  // orders of magnitude under the relay's 1 MiB frame cap.
  const CHUNK_BYTES = 16 * 1024;

  const BINARY_HEADER_BYTES = 8; // uint32 transfer id + uint32 chunk index

  let nextXferId = 1;

  // Receiving transfers, keyed by transfer id.
  const incoming = new Map();
  // Outgoing transfers, so they can be cancelled.
  const outgoing = new Map();

  const listeners = { progress: [], complete: [], error: [], listing: [], request: [] };

  function on(event, fn) {
    if (listeners[event]) listeners[event].push(fn);
  }

  function emit(event, ...args) {
    (listeners[event] || []).forEach((fn) => {
      try { fn(...args); } catch (e) { console.error('[qdrive/transfer]', e); }
    });
  }

  function writeHeader(xfer, index) {
    const header = new Uint8Array(BINARY_HEADER_BYTES);
    const view = new DataView(header.buffer);
    view.setUint32(0, xfer, false);
    view.setUint32(4, index, false);
    return header;
  }

  function readHeader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, BINARY_HEADER_BYTES);
    return { xfer: view.getUint32(0, false), index: view.getUint32(4, false) };
  }

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ------------------------------------------------------------- sending */

  async function sendFile(peer, xfer, meta, fromChunk) {
    const blob = await Store.getBlob(meta.id);
    if (!blob) {
      await P2P.sendJson(peer, { t: 'error', xfer: xfer, message: 'file is no longer here' });
      return;
    }

    const total = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
    await P2P.sendJson(peer, { t: 'begin', xfer: xfer, meta: meta, chunks: total });

    const record = { cancelled: false };
    outgoing.set(xfer, record);

    try {
      for (let index = fromChunk || 0; index < total; index++) {
        if (record.cancelled) return;
        if (!peer.connected) throw new Error('connection lost');

        // Slice per chunk rather than reading the whole file: a Blob slice is
        // a view, so a 2 GB file never has to fit in memory at once.
        const slice = blob.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
        const bytes = new Uint8Array(await slice.arrayBuffer());
        await P2P.sendBinary(peer, writeHeader(xfer, index), bytes);

        emit('progress', {
          direction: 'up', xfer: xfer, meta: meta,
          done: index + 1, total: total,
          bytes: Math.min(blob.size, (index + 1) * CHUNK_BYTES), size: blob.size,
        });
      }
      await P2P.sendJson(peer, { t: 'end', xfer: xfer });
      // The sender needs its own completion signal. 'complete' is otherwise
      // only emitted by finishReceive, on the far side -- so without this the
      // uploader's progress bar would sit at 100% forever with nothing to
      // clear it.
      emit('complete', { direction: 'up', xfer: xfer, meta: meta });
    } catch (e) {
      await P2P.sendJson(peer, { t: 'error', xfer: xfer, message: e.message });
      emit('error', { direction: 'up', xfer: xfer, meta: meta, message: e.message });
    } finally {
      outgoing.delete(xfer);
    }
  }

  /* ----------------------------------------------------------- receiving */

  function beginReceive(peer, msg) {
    // Resuming reuses the existing partial rather than starting over.
    const existing = incoming.get(msg.xfer);
    const chunks = existing ? existing.chunks : new Array(msg.chunks);
    incoming.set(msg.xfer, {
      peer: peer,
      meta: msg.meta,
      total: msg.chunks,
      chunks: chunks,
      received: existing ? existing.received : 0,
      bytes: existing ? existing.bytes : 0,
    });
  }

  function receiveChunk(bytes) {
    const { xfer, index } = readHeader(bytes);
    const entry = incoming.get(xfer);
    if (!entry) return; // a stray chunk from a cancelled transfer

    // Copy out of the frame: `bytes` is a view onto the decrypted frame
    // buffer, which is reused, so holding the view would alias later data.
    const payload = bytes.slice(BINARY_HEADER_BYTES);
    if (entry.chunks[index] === undefined) {
      entry.received++;
      entry.bytes += payload.length;
    }
    entry.chunks[index] = payload;

    emit('progress', {
      direction: 'down', xfer: xfer, meta: entry.meta,
      done: entry.received, total: entry.total,
      bytes: entry.bytes, size: entry.meta.size,
    });
  }

  async function finishReceive(xfer) {
    const entry = incoming.get(xfer);
    if (!entry) return;
    incoming.delete(xfer);

    const missing = [];
    for (let i = 0; i < entry.total; i++) {
      if (entry.chunks[i] === undefined) missing.push(i);
    }
    if (missing.length) {
      emit('error', {
        direction: 'down', xfer: xfer, meta: entry.meta,
        message: 'transfer incomplete (' + missing.length + ' chunks missing)',
      });
      return;
    }

    const blob = new Blob(entry.chunks, { type: entry.meta.mime || 'application/octet-stream' });

    // Verify before committing. The transport is authenticated and encrypted,
    // so this is not about tampering -- it catches truncation and assembly
    // bugs, which are the realistic failure modes.
    const digest = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    if (entry.meta.sha256 && digest !== entry.meta.sha256) {
      emit('error', {
        direction: 'down', xfer: xfer, meta: entry.meta,
        message: 'the copy that arrived does not match the original -- discarded',
      });
      return;
    }

    const saved = await Store.add(blob, entry.meta.name, 'my other device');
    emit('complete', { direction: 'down', xfer: xfer, meta: saved });
  }

  /* -------------------------------------------------------------- wiring */

  function attach() {
    P2P.on('json', async (peer, msg) => {
      try {
        switch (msg.t) {
          case 'list': {
            // listShared, never list: a hidden file must not appear here.
            const files = await Store.listShared();
            await P2P.sendJson(peer, { t: 'listing', files: files });
            return;
          }
          case 'listing':
            emit('listing', peer, msg.files || []);
            return;
          case 'get': {
            const meta = await Store.getMeta(msg.id);
            // Hiding has to be enforced HERE too, not just in the listing. A
            // peer that saw the file before it was hidden still knows its id,
            // and would otherwise be able to fetch it anyway. Same "no such
            // file" answer either way, so hiding a file is indistinguishable
            // from deleting it.
            if (!meta || meta.hidden) {
              await P2P.sendJson(peer, { t: 'error', xfer: msg.xfer, message: 'no such file' });
              return;
            }
            emit('request', { meta: meta, xfer: msg.xfer });
            await sendFile(peer, msg.xfer, meta, msg.fromChunk || 0);
            return;
          }
          case 'begin':
            beginReceive(peer, msg);
            return;
          case 'end':
            await finishReceive(msg.xfer);
            return;
          case 'error': {
            const entry = incoming.get(msg.xfer);
            emit('error', {
              direction: 'down', xfer: msg.xfer,
              meta: entry ? entry.meta : null, message: msg.message,
            });
            incoming.delete(msg.xfer);
            return;
          }
          default:
            return;
        }
      } catch (e) {
        emit('error', { message: e.message });
      }
    });

    P2P.on('binary', (peer, bytes) => receiveChunk(bytes));

    // A dropped connection leaves partial transfers in place rather than
    // discarding them, so reconnecting can resume from the first gap.
    P2P.on('peer', (event) => {
      if (event === 'disconnected') {
        incoming.forEach((entry, xfer) => {
          emit('error', {
            direction: 'down', xfer: xfer, meta: entry.meta,
            message: 'connection lost -- ' + entry.received + ' of ' + entry.total +
              ' chunks kept, request it again to resume',
          });
        });
        outgoing.forEach((record) => { record.cancelled = true; });
        outgoing.clear();
      }
    });
  }

  const Transfer = {
    CHUNK_BYTES: CHUNK_BYTES,
    on: on,
    attach: attach,

    requestListing(peer) {
      return P2P.sendJson(peer, { t: 'list' });
    },

    // Push our current shared list without being asked. Used whenever the set
    // of available files changes, so the other device updates live.
    async sendListing(peer) {
      const files = await Store.listShared();
      return P2P.sendJson(peer, { t: 'listing', files: files });
    },

    // Asks the peer for a file. If a partial copy from an interrupted attempt
    // is still around, resumes from the first chunk that never arrived.
    requestFile(peer, meta) {
      const xfer = nextXferId++;
      let fromChunk = 0;
      for (const [, entry] of incoming) {
        if (entry.meta && entry.meta.sha256 === meta.sha256) {
          let i = 0;
          while (entry.chunks[i] !== undefined) i++;
          fromChunk = i;
          break;
        }
      }
      return P2P.sendJson(peer, { t: 'get', xfer: xfer, id: meta.id, fromChunk: fromChunk });
    },

    // Pushes a local file to the peer, by asking it to fetch from us. Kept
    // symmetric with requestFile so both directions use one code path.
    async pushFile(peer, meta) {
      const xfer = nextXferId++;
      await sendFile(peer, xfer, meta, 0);
    },

    activeCount: () => incoming.size + outgoing.size,
  };

  global.QDriveTransfer = Transfer;
})(window);
