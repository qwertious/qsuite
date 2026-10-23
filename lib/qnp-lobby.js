/*
 * qnp-lobby.js -- browser client for the QNP lobby capability (server
 * discovery). A host toggles on a persistent, signed listing (game/title/
 * player-count -- no connection material in it); anyone browsing can click
 * it at any time, which is the moment a fresh QRP handshake actually starts:
 * the guest builds and posts their own Offer targeted at that host, the host
 * (polling while its listing is up) picks it up and answers it, the guest
 * polls for that answer. Because the listing carries no single-use Offer, it
 * isn't tied to one handshake's lifetime and isn't limited to one guest --
 * any number of people can click in over the listing's life.
 *
 * The node never understands the Offer/Answer it moves -- same trust model
 * as qnp-client.js's relay: opaque to the node, independently verified by
 * whichever client eventually processes it (QRP.verifyRendezvous, exactly
 * as the manual-code flow already does). A password-protected listing goes
 * one step further: the guest encrypts their Offer client-side before it's
 * ever POSTed, so the node holds ciphertext it cannot read even if it wanted
 * to, and the host decrypts each incoming offer locally with the same
 * password it set when it turned hosting on.
 *
 * Password crypto mirrors accounts/qip.js's keystore exactly (PBKDF2-SHA512,
 * 600000 iterations, AES-256-GCM) -- same primitives already trusted to
 * protect an actual private key, reused here rather than inventing a second
 * pattern for a lower-stakes secret.
 */
(function (global) {
  'use strict';

  const QIP = global.QIP;
  if (!QIP) throw new Error('qnp-lobby.js requires accounts/qip.js to be loaded first');

  const ANNOUNCE_AUD = 'urn:qnp:lobby';
  const ANNOUNCE_TTL = 45;      // must stay <= the node's ANNOUNCE_MAX_TTL (lobby.py)
  const HEARTBEAT_MS = 20000;   // comfortably under ANNOUNCE_TTL
  const OFFER_POLL_MS = 3000;   // how often a host checks for new incoming offers
  const KDF_ITERATIONS = 600000;
  const subtle = global.crypto.subtle;
  const enc = new TextEncoder();

  function concatBytes() {
    const parts = Array.prototype.slice.call(arguments).map(p =>
      typeof p === 'string' ? enc.encode(p) : new Uint8Array(p));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  /* ------------------------------------------------------- password crypto */

  async function deriveWrappingKey(password, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-512' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Encrypts an Offer object with a password -- returns a self-contained
  // string (salt/nonce/ciphertext all inline). Used by a guest, on the way
  // into a password-protected listing's offer submission.
  async function encryptOffer(offerObj, password) {
    const salt = global.crypto.getRandomValues(new Uint8Array(16));
    const nonce = global.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveWrappingKey(password, salt, KDF_ITERATIONS);
    const pt = enc.encode(JSON.stringify(offerObj));
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode('QNP1-LOBBY-OFFER\0') }, key, pt);
    return JSON.stringify({
      profile: 'pbkdf2-aesgcm', iterations: KDF_ITERATIONS,
      salt: QIP.b64u(salt), nonce: QIP.b64u(nonce), ct: QIP.b64u(new Uint8Array(ct)),
    });
  }

  // Inverse of encryptOffer -- throws (wrong password, or corrupt/foreign
  // data) rather than returning anything partial. Used by a host, decrypting
  // each incoming offer with the password it set when hosting was toggled on.
  async function decryptOffer(ciphertextStr, password) {
    let env;
    try { env = JSON.parse(ciphertextStr); } catch (e) { throw new Error('not a valid encrypted offer'); }
    if (env.profile !== 'pbkdf2-aesgcm') throw new Error('unsupported encryption profile');
    const key = await deriveWrappingKey(password, QIP.unb64u(env.salt), env.iterations || KDF_ITERATIONS);
    let pt;
    try {
      pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: QIP.unb64u(env.nonce), additionalData: enc.encode('QNP1-LOBBY-OFFER\0') },
        key, QIP.unb64u(env.ct));
    } catch (e) {
      throw new Error('wrong password');
    }
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* -------------------------------------------------------------- signing */

  function announceSigningInput(msg) {
    const copy = {};
    for (const k of Object.keys(msg)) { if (k !== 'sig') copy[k] = msg[k]; }
    return concatBytes('QNP1-LOBBY\0', enc.encode(QIP.cjson(copy)));
  }

  async function buildAnnounce(opts) {
    const now = Math.floor(Date.now() / 1000);
    // opts.players may be a function -- hosting is a persistent, re-announced
    // (heartbeat) listing now, not a one-shot snapshot, so a live player
    // count needs to be read fresh on every announce, not just the first.
    const players = typeof opts.players === 'function' ? opts.players() : (opts.players || { current: 1 });
    const msg = {
      qnp: 1, typ: 'lobby-announce', game: opts.game,
      uuid: opts.uuid, aud: ANNOUNCE_AUD,
      nonce: QIP.b64u(global.crypto.getRandomValues(new Uint8Array(16))),
      iat: now, exp: now + ANNOUNCE_TTL, key: opts.kpIdentity.pub,
      title: opts.title || '', players: players,
      password_protected: !!opts.password,
    };
    msg.sig = await QIP.sign(opts.kpIdentity, announceSigningInput(msg));
    return msg;
  }

  /* ----------------------------------------------------------- discovery */

  // Same "ask nodes you already know" pattern as qnp-client.js's
  // discoverRelay -- returns the first node's HTTP base URL that advertises
  // the "lobby" capability, or null.
  async function discoverLobby(nodeUrls) {
    for (const raw of (nodeUrls || [])) {
      const base = raw.replace(/\/$/, '');
      try {
        const res = await fetch(base + '/qip/v1/node');
        if (!res.ok) continue;
        const node = await res.json();
        if (node.capabilities && node.capabilities.indexOf('lobby') !== -1) return base;
      } catch (e) {
        // unreachable node -- try the next one
      }
    }
    return null;
  }

  /* ------------------------------------------------------------- host side */

  async function announce(base, opts) {
    const msg = await buildAnnounce(opts);
    const res = await fetch(base + '/qnp/v1/lobby/announce', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announce: msg, chain: opts.chain }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error('announce rejected: ' + (body.error || res.status));
  }

  // Toggles hosting on: announces immediately, re-announces on HEARTBEAT_MS
  // for as long as it isn't stopped (a persistent listing, not a one-shot),
  // and polls for incoming guest offers on OFFER_POLL_MS, calling
  // opts.onOffer(entry) once per new session id it sees (never re-delivers
  // one it's already handed off, even across polls). opts.onOffer does the
  // actual QRP-level work (build an answer, sign it, submit it back) --
  // this layer only owns the node protocol, not the handshake itself.
  // Returns { stop }.
  function startHosting(base, opts) {
    let stopped = false;
    const seen = new Set();

    const doAnnounce = () => announce(base, opts).catch((e) => {
      console.warn('[QNPLobby] announce failed: ' + e.message);
    });

    const doPoll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(base + '/qnp/v1/lobby/offers?host=' + encodeURIComponent(opts.uuid));
        if (!res.ok) return;
        const body = await res.json();
        for (const entry of (body.offers || [])) {
          if (seen.has(entry.session)) continue;
          seen.add(entry.session);
          Promise.resolve(opts.onOffer(entry)).catch((e) => {
            console.warn('[QNPLobby] onOffer handler failed: ' + e.message);
          });
        }
      } catch (e) {
        // transient poll failure -- next interval tries again
      }
    };

    doAnnounce();
    const heartbeatTimer = setInterval(doAnnounce, HEARTBEAT_MS);
    const pollTimer = setInterval(doPoll, OFFER_POLL_MS);
    doPoll();

    return {
      stop: () => { stopped = true; clearInterval(heartbeatTimer); clearInterval(pollTimer); },
    };
  }

  async function pollAnswer(base, session) {
    const res = await fetch(base + '/qnp/v1/lobby/answer?session=' + encodeURIComponent(session));
    if (!res.ok) throw new Error('poll failed: ' + res.status);
    const body = await res.json();
    return body.found ? { answer: body.answer, chain: body.chain } : null;
  }

  // Polls until an Answer arrives or timeoutMs elapses (null on timeout).
  function pollUntilAnswered(base, session, opts) {
    opts = opts || {};
    const intervalMs = opts.intervalMs || 2000;
    const timeoutMs = opts.timeoutMs || 60000;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const result = await pollAnswer(base, session);
          if (result) return resolve(result);
        } catch (e) {
          return reject(e);
        }
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  /* ------------------------------------------------------------ guest side */

  async function list(base, game) {
    const res = await fetch(base + '/qnp/v1/lobby/list?game=' + encodeURIComponent(game));
    if (!res.ok) throw new Error('list failed: ' + res.status);
    const body = await res.json();
    return body.entries || [];
  }

  // Posts a freshly-built Offer targeted at a specific host, keyed by this
  // guest's own session id (from the Offer itself) -- the actual moment a
  // click on a listing becomes a real handshake attempt. opts: { hostUuid,
  // session, offer: {qrp, sdp}, chain, password }.
  async function submitOffer(base, opts) {
    const payload = opts.password ? await encryptOffer(opts.offer, opts.password) : opts.offer;
    const res = await fetch(base + '/qnp/v1/lobby/offer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: opts.hostUuid, session: opts.session, offer: payload, chain: opts.chain }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error('offer rejected: ' + (body.error || res.status));
  }

  async function submitAnswer(base, opts) {
    const res = await fetch(base + '/qnp/v1/lobby/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: opts.session, answer: opts.answer, chain: opts.chain }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error('answer rejected: ' + (body.error || res.status));
  }

  global.QNPLobby = {
    discoverLobby: discoverLobby,
    startHosting: startHosting,
    submitOffer: submitOffer,
    pollUntilAnswered: pollUntilAnswered,
    list: list,
    encryptOffer: encryptOffer,
    decryptOffer: decryptOffer,
    submitAnswer: submitAnswer,
  };
})(window);
