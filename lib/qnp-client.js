/*
 * qnp-client.js -- browser client for the QNP relay fallback (qip-qnp/SPEC-v1.md).
 *
 * QRP's Offer/Answer already authenticate both identities and derive an
 * end-to-end session key completely independent of how bytes travel (see
 * transport-webrtc.js's header). QNP fills in the fallback transport for
 * when direct WebRTC can't find a path (symmetric NAT, etc.): instead of a
 * single fixed TURN server, the game discovers a relay-capable QIP node
 * (one already advertised on /qip/v1/node's `capabilities`), opens a plain
 * WebSocket to it, and asks it to pair two signed allocation requests for
 * the same QRP session.
 *
 * The relay never sees plaintext: everything sent over `send()`/received
 * via `onData` is already QRP-sealed AES-GCM ciphertext (multiplayer.js
 * calls QRP.sealData/openData either way) -- this file only moves opaque
 * bytes, same contract QRPTransport.PeerConnection has.
 *
 * RelayTransport deliberately mirrors QRPTransport.PeerConnection's public
 * shape (constructor(onData, onStateChange), .send(bytes), .close(),
 * settable .onData/.onStateChange, 'channel-open'/'channel-closed' states)
 * so multiplayer.js's race logic can treat either transport interchangeably
 * and wireDataMessages() doesn't need to know which one won.
 */
(function (global) {
  'use strict';

  const QIP = global.QIP;
  if (!QIP) throw new Error('qnp-client.js requires accounts/qip.js to be loaded first');

  const ALLOCATE_AUD = 'urn:qnp:relay';
  const enc = new TextEncoder();

  function concatBytes() {
    const parts = Array.prototype.slice.call(arguments);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  async function buildAllocate(opts) {
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.ttl || 30;
    const msg = {
      qnp: 1, typ: 'relay-allocate', session: opts.session, uuid: opts.uuid, aud: ALLOCATE_AUD,
      nonce: QIP.b64u(global.crypto.getRandomValues(new Uint8Array(16))),
      iat: now, exp: now + ttl, key: opts.kpIdentity.pub,
    };
    const copy = {};
    for (const k of Object.keys(msg)) copy[k] = msg[k];
    const signInput = concatBytes(enc.encode('QNP1-ALLOC\0'), enc.encode(QIP.cjson(copy)));
    msg.sig = await QIP.sign(opts.kpIdentity, signInput);
    return msg;
  }

  // Asks each configured node (in order) whether it advertises the "relay"
  // capability, and if so, its actual ws:// endpoint. v1 discovery is
  // deliberately this simple -- "ask nodes you already know" (SPEC-v1.md
  // section 3) -- ranking/health-checking multiple relays is v2+.
  async function discoverRelay(nodeUrls) {
    for (const raw of (nodeUrls || [])) {
      const base = raw.replace(/\/$/, '');
      try {
        const nodeResp = await fetch(base + '/qip/v1/node');
        if (!nodeResp.ok) continue;
        const node = await nodeResp.json();
        if (!node.capabilities || node.capabilities.indexOf('relay') === -1) continue;
        const relayResp = await fetch(base + '/qnp/v1/relay');
        if (!relayResp.ok) continue;
        const relay = await relayResp.json();
        if (relay.ws_url) return relay.ws_url;
      } catch (e) {
        // unreachable node -- try the next one, never let discovery hang the caller
      }
    }
    return null;
  }

  class RelayTransport {
    constructor(onData, onStateChange) {
      this.sock = null;
      this.onData = onData || function () {};
      this.onStateChange = onStateChange || function () {};
      this._closed = false;
      this._settled = false;
    }

    // Opens the WebSocket, sends the signed allocation request + identity
    // chain, and resolves once the relay reports 'relay-ready' (paired with
    // the other side) -- or rejects on 'relay-error' / socket failure /
    // closing before pairing completes.
    allocate(opts) {
      return new Promise((resolve, reject) => {
        let sock;
        try {
          sock = new WebSocket(opts.wsUrl);
        } catch (e) {
          reject(e);
          return;
        }
        this.sock = sock;
        sock.binaryType = 'arraybuffer';
        const settle = (fn, arg) => {
          if (this._settled) return;
          this._settled = true;
          fn(arg);
        };
        sock.onopen = async () => {
          try {
            const allocate = await buildAllocate(opts);
            sock.send(new TextEncoder().encode(JSON.stringify({ allocate: allocate, chain: opts.chain })));
          } catch (e) {
            settle(reject, e);
          }
        };
        sock.onmessage = (e) => {
          if (typeof e.data === 'string') {
            let parsed;
            try { parsed = JSON.parse(e.data); } catch (err) { return; }
            if (parsed.typ === 'relay-ready') {
              settle(resolve);
              this.onStateChange('channel-open');
            } else if (parsed.typ === 'relay-error') {
              settle(reject, new Error('relay: ' + (parsed.reason || 'allocation rejected')));
            }
          } else {
            this.onData(new Uint8Array(e.data));
          }
        };
        sock.onerror = () => settle(reject, new Error('relay WebSocket error'));
        sock.onclose = (e) => {
          settle(reject, new Error('relay closed before pairing, code ' + e.code));
          if (!this._closed) this.onStateChange('channel-closed');
        };
      });
    }

    send(bytes) {
      if (this.sock && this.sock.readyState === WebSocket.OPEN) {
        this.sock.send(bytes);
        return true;
      }
      return false;
    }

    close() {
      this._closed = true;
      if (this.sock) this.sock.close();
    }
  }

  global.QNP = { discoverRelay: discoverRelay, RelayTransport: RelayTransport };
})(window);
