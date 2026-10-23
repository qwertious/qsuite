/*
 * qrp-web.js -- browser port of the Qwertious Rendezvous Protocol (QRP v1).
 *
 * Mirrors qip-p2p/lib/qrp.py section-for-section (see qip-p2p/SPEC-v1.md).
 * Depends on window.QIP (accounts/qip.js) for the primitives QRP explicitly
 * reuses from QIP identity: b64u, cjson, sha256, Ed25519 sign/verify. This
 * file adds what QIP doesn't have: X25519 key agreement, HKDF, and the data
 * channel AEAD.
 *
 * ONE deliberate deviation from SPEC-v1.md, and it needs to be visible, not
 * buried: the data channel and connectivity-check AEAD use AES-256-GCM here,
 * not XChaCha20-Poly1305. WebCrypto has no XChaCha20-Poly1305 and never will
 * (it isn't a NIST-standardised algorithm), and vendoring a JS implementation
 * into a page is exactly the kind of "no homemade/vendored crypto" QIP's own
 * spec rules out (SPEC-v1.md section 2). This is the SAME choice QIP's own
 * browser keystore already made (the `pbkdf2-aesgcm` profile) for the same
 * reason. AES-GCM's nonce is 12 bytes, not 24, so the data-channel and
 * connectivity-check nonce construction differs from qrp.py's accordingly --
 * everything else (HKDF derivation, the counter, the replay window, the
 * Offer/Answer format) is unchanged and interoperates with a native QRP peer
 * right up to the AEAD call itself.
 *
 * Requires: a browser with WebCrypto X25519 support (Chrome 133+, Firefox
 * 131+, Safari 17+ roughly). Older browsers will throw on generateKeypair();
 * check QRP.supported() before use.
 */
(function (global) {
  'use strict';

  const QIP = global.QIP;
  if (!QIP) throw new Error('qrp-web.js requires accounts/qip.js to be loaded first');

  const QRP_QIP = 1;
  const MAX_TTL = 120;
  const REPLAY_WINDOW_SIZE = 64;
  const subtle = global.crypto.subtle;
  const enc = new TextEncoder();

  class QrpError extends Error {
    constructor(reason, detail) {
      super(detail ? reason + ': ' + detail : reason);
      this.reason = reason;
    }
  }

  function concatBytes() {
    const parts = Array.prototype.slice.call(arguments).map(p =>
      typeof p === 'string' ? enc.encode(p) : new Uint8Array(p));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  async function supported() {
    try {
      const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
      await subtle.exportKey('raw', kp.publicKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* --------------------------------------------------- section 2: X25519 */

  async function x25519Keypair() {
    const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    return { priv: kp.privateKey, pub: pub };
  }

  function x25519PubStr(pubRaw) {
    return 'x25519:' + QIP.b64u(pubRaw);
  }

  function x25519PubRaw(s) {
    if (typeof s !== 'string' || s.indexOf('x25519:') !== 0) {
      throw new QrpError('malformed', 'unknown ephemeral key algorithm');
    }
    const raw = QIP.unb64u(s.slice(7));
    if (raw.length !== 32) throw new QrpError('malformed', 'bad x25519 key length');
    return raw;
  }

  /* ---------------------------------------------- section 4: Offer/Answer */

  function signInput(msg) {
    const copy = {};
    for (const k of Object.keys(msg)) if (k !== 'sig') copy[k] = msg[k];
    return concatBytes('QRP1-SIG\0', enc.encode(QIP.cjson(copy)));
  }

  async function build(typ, session, uuid, aud, kpIdentity, ephemeralPub, candidates, ttl, extra) {
    if (!(ttl > 0 && ttl <= MAX_TTL)) throw new QrpError('malformed', 'bad ttl');
    const now = Math.floor(Date.now() / 1000);
    const msg = Object.assign({
      qip: QRP_QIP, typ: typ, session: session, uuid: uuid, aud: aud,
      nonce: QIP.b64u(global.crypto.getRandomValues(new Uint8Array(16))),
      iat: now, exp: now + ttl, key: kpIdentity.pub,
      ephemeral: x25519PubStr(ephemeralPub), candidates: candidates
    }, extra || {});
    msg.sig = await QIP.sign(kpIdentity, signInput(msg));
    return msg;
  }

  async function makeOffer(opts) {
    const session = opts.session || QIP.b64u(global.crypto.getRandomValues(new Uint8Array(16)));
    return build('rendezvous-offer', session, opts.uuid, opts.aud, opts.kpIdentity,
      opts.ephemeralPub, opts.candidates || [], opts.ttl || 60, opts.extra);
  }

  async function makeAnswer(opts) {
    return build('rendezvous-answer', opts.offer.session, opts.uuid, opts.aud,
      opts.kpIdentity, opts.ephemeralPub, opts.candidates || [], opts.ttl || 60,
      Object.assign({ in_reply_to: opts.offer.session }, opts.extra));
  }

  class NonceTracker {
    constructor() { this._seen = new Set(); }
    checkAndRecord(nonce) {
      if (this._seen.has(nonce)) throw new QrpError('nonce_used', 'rendezvous nonce reused');
      this._seen.add(nonce);
    }
  }

  /* ------------------------------------------- section 5: verification */

  async function verifyRendezvous(msg, state, opts) {
    const now = opts.now || Math.floor(Date.now() / 1000);
    if (!msg || msg.qip !== QRP_QIP || msg.typ !== opts.expectedTyp) {
      throw new QrpError('malformed', 'not a v1 ' + opts.expectedTyp);
    }
    if (opts.inReplyTo != null) {
      if (msg.in_reply_to !== opts.inReplyTo || msg.session !== opts.inReplyTo) {
        throw new QrpError('malformed', 'session/in_reply_to mismatch');
      }
    }
    if (typeof msg.nonce !== 'string') throw new QrpError('malformed', 'missing nonce');
    opts.nonces.checkAndRecord(msg.nonce);
    if (msg.aud !== opts.aud) throw new QrpError('aud_mismatch', 'wrong audience');
    if (!Number.isInteger(msg.iat) || !Number.isInteger(msg.exp)) {
      throw new QrpError('malformed', 'bad iat/exp');
    }
    if (msg.iat > now + 60) throw new QrpError('malformed', 'issued in the future');
    if (msg.exp <= now) throw new QrpError('expired', 'offer/answer has expired');
    if (msg.exp - msg.iat > MAX_TTL) throw new QrpError('exp_too_far', 'lifetime too long');
    if (msg.uuid !== state.uuid) throw new QrpError('uuid_mismatch', 'wrong identity');
    if (msg.key !== state.activeKey) throw new QrpError('key_not_active', 'superseded key');
    x25519PubRaw(msg.ephemeral || '');
    await QIP.verify(state.activeKey, signInput(msg), msg.sig);
  }

  /* --------------------------------- section 6: HKDF + session key derivation */

  async function deriveSessionKeys(myEphemeralPriv, theirEphemeralPubRaw, sessionId, amInitiator) {
    const theirKey = await subtle.importKey('raw', theirEphemeralPubRaw, { name: 'X25519' }, false, []);
    const shared = await subtle.deriveBits({ name: 'X25519', public: theirKey }, myEphemeralPriv, 256);
    const ikmKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const salt = enc.encode(sessionId);

    async function expand(infoStr) {
      const bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: salt, info: enc.encode(infoStr) },
        ikmKey, 256);
      return new Uint8Array(bits);
    }

    const i2r = await expand('QRP1-KDF\0init->resp');
    const r2i = await expand('QRP1-KDF\0resp->init');
    return amInitiator ? { tx: i2r, rx: r2i } : { tx: r2i, rx: i2r };
  }

  /* ------------------------------------------- section 8: connectivity check */
  // AES-256-GCM, 12-byte nonce -- see the file header for why this differs
  // from qrp.py's XChaCha20-Poly1305 / 24-byte nonce.

  async function importAesKey(rawKey) {
    return subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function makeCheck(txKeyRaw, session) {
    const key = await importAesKey(txKeyRaw);
    const nonce = new Uint8Array(12); // fixed nonce: safe here because the
    // plaintext is also fixed (always `session`) -- see qrp.py's identical
    // comment on make_check for the full reasoning. Retrying the same check
    // just reproduces the same ciphertext; it never pairs this nonce with a
    // different plaintext under the same key.
    const aad = concatBytes('QRP1-CHECK\0', session);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad },
      key, enc.encode(session));
    return new Uint8Array(ct);
  }

  async function verifyCheck(rxKeyRaw, session, blob) {
    try {
      const key = await importAesKey(rxKeyRaw);
      const nonce = new Uint8Array(12);
      const aad = concatBytes('QRP1-CHECK\0', session);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, blob);
      return new TextDecoder().decode(pt) === session;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------- section 9: data channel */

  async function sealData(txKeyRaw, counter, session, plaintext) {
    if (!(counter >= 0 && counter < Number.MAX_SAFE_INTEGER)) {
      throw new QrpError('malformed', 'counter out of range');
    }
    const key = await importAesKey(txKeyRaw);
    const ctr = new Uint8Array(8);
    new DataView(ctr.buffer).setBigUint64(0, BigInt(counter), false);
    const nonce = concatBytes(new Uint8Array(4), ctr); // 4 + 8 = 12 bytes
    const aad = concatBytes('QRP1-DATA\0', session);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
    return concatBytes(ctr, new Uint8Array(ct));
  }

  class ReplayWindow {
    constructor(size) {
      this.size = size || REPLAY_WINDOW_SIZE;
      this.highest = -1;
      this.seen = 0n;
    }
    checkAndRecord(counter) {
      const c = BigInt(counter);
      if (this.highest < 0) {
        this.highest = c; this.seen = 1n; return true;
      }
      if (c > this.highest) {
        const shift = c - this.highest;
        this.seen = shift < BigInt(this.size) ?
          (this.seen << shift) & ((1n << BigInt(this.size)) - 1n) : 0n;
        this.highest = c;
        this.seen |= 1n;
        return true;
      }
      const age = this.highest - c;
      if (age >= BigInt(this.size)) return false;
      const bit = 1n << age;
      if (this.seen & bit) return false;
      this.seen |= bit;
      return true;
    }
  }

  async function openData(rxKeyRaw, session, packet, window) {
    if (packet.length < 8) throw new QrpError('malformed', 'packet too short');
    const ctr = packet.slice(0, 8);
    const counter = new DataView(ctr.buffer, ctr.byteOffset, 8).getBigUint64(0, false);
    if (!window.checkAndRecord(counter)) throw new QrpError('replayed', 'counter already seen');
    const key = await importAesKey(rxKeyRaw);
    const nonce = concatBytes(new Uint8Array(4), ctr);
    const aad = concatBytes('QRP1-DATA\0', session);
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad },
        key, packet.slice(8));
      return new Uint8Array(pt);
    } catch (e) {
      throw new QrpError('sig_invalid', 'data channel AEAD failed');
    }
  }

  global.QRP = {
    VERSION: QRP_QIP, QrpError: QrpError, supported: supported,
    x25519Keypair: x25519Keypair, x25519PubStr: x25519PubStr, x25519PubRaw: x25519PubRaw,
    makeOffer: makeOffer, makeAnswer: makeAnswer, NonceTracker: NonceTracker,
    verifyRendezvous: verifyRendezvous, deriveSessionKeys: deriveSessionKeys,
    makeCheck: makeCheck, verifyCheck: verifyCheck,
    sealData: sealData, openData: openData, ReplayWindow: ReplayWindow
  };
})(window);
