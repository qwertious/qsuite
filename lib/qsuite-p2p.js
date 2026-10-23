/*
 * qsuite-p2p.js -- authenticated, encrypted device-to-device connections for
 * qSuite, built on the same QIP/QRP/QNP stack the game uses.
 *
 * This is the game-agnostic half of inmetanty's multiplayer.js, lifted and
 * generalised. The five files in lib/ have zero coupling to the game; all of
 * the coupling lived in multiplayer.js, so this file replaces it rather than
 * copying it.
 *
 * ============================================================================
 * HOW PAIRING WORKS, AND WHY IT IS SAFE
 * ============================================================================
 * The QNP lobby keys every listing by the announcing account's uuid, so an
 * account has at most one listing -- which is exactly the shape of "my other
 * device". So:
 *
 *   1. The device holding the files announces a listing under its own uuid.
 *   2. The other device lists the lobby and looks for the entry whose uuid is
 *      ITS OWN. That is its sibling device, by construction.
 *   3. It builds a fresh QRP Offer -- signed by the account's key -- and posts
 *      it to the lobby targeted at that uuid.
 *   4. The sharing device verifies the incoming Offer and then checks one more
 *      thing: that the Offer's uuid equals its own. Anything else is dropped.
 *
 * Step 4 is the whole access-control story. Producing an Offer that verifies
 * as uuid X requires X's private key, which only that account's devices have.
 * So the listing being public is harmless: anyone can see that an account has
 * a device online, but nobody without the key can connect to it. No pairing
 * code, no shared secret, no trust in the node.
 *
 * The node never sees plaintext either way -- QRP seals every data frame with
 * AES-256-GCM under keys derived from an X25519 exchange, so a relay carries
 * ciphertext it cannot read.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   - No guest identities. A throwaway key has no sibling devices, so pairing
 *     is meaningless without a real account.
 *   - No third-party TURN. The suite configures STUN + the QNP relay only, so
 *     a fallback path routes through infrastructure the operator runs rather
 *     than a public demo service. See configureTurnServers([]) in the app.
 */
(function (global) {
  'use strict';

  const QIP = global.QIP;
  if (!QIP) throw new Error('qsuite-p2p.js requires accounts/qip.js to be loaded first');

  // Audience binding. A QRP message is only valid for the audience it was
  // signed for, so a qDrive offer cannot be replayed into the game (or into
  // a future qSuite app) and vice versa.
  const AUD = 'urn:qip:app:qdrive';

  // Frame kinds. Every plaintext frame starts with one of these.
  const FRAME_JSON = 0;
  const FRAME_BINARY = 1;

  const P2P = {
    identity: null,     // { kp, uuid, chain, username }
    peers: {},          // uuid -> peer entry
    pendingOutbound: {}, // offer session id -> peer entry (uuid unknown until the answer)
    relayUrl: null,
    lobbyBase: null,
    sharing: null,      // { stop } while a listing is up
    log: [],
    // Debug: force the relay to win the direct-vs-relay race, so relay
    // transport can be exercised on a network where direct always wins.
    debugForceRelayOnly: false,
  };

  Object.defineProperty(P2P, 'connected', {
    get() { return Object.keys(P2P.peers).some((u) => P2P.peers[u].connected); },
  });

  /* ------------------------------------------------------------- plumbing */

  const listeners = { log: [], peer: [], json: [], binary: [] };

  function on(event, fn) {
    if (listeners[event]) listeners[event].push(fn);
  }

  function emit(event, ...args) {
    (listeners[event] || []).forEach((fn) => {
      try { fn(...args); } catch (e) { console.error('[qsuite-p2p] listener failed', e); }
    });
  }

  function logLine(message) {
    const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + message;
    P2P.log.push(line);
    if (P2P.log.length > 200) P2P.log.shift();
    emit('log', line);
  }

  // WebCrypto's subtle interface only exists in a secure context: HTTPS, or
  // http://localhost / http://127.0.0.1. A LAN IP, a file:// path and a
  // plain-HTTP tunnel all fail -- and they fail deep inside qip.js with a
  // cryptic undefined-property error, so this is checked once, up front.
  function secureContextProblem() {
    if (global.isSecureContext && global.crypto && global.crypto.subtle) return null;
    return 'This page is not a secure context (' + location.protocol + '//' +
      location.host + '), so the browser will not provide the cryptography ' +
      'qDrive needs. Use HTTPS, or http://localhost / http://127.0.0.1 when ' +
      'running locally -- a LAN IP or a file:// path will not work.';
  }

  /* ------------------------------------------------------------- identity */

  function lsRead(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }

  // Reads whatever Qwertious Accounts already stored on this device. Same
  // localStorage keys accounts/qip-ui.js writes, read-only.
  //
  // Note qip.chains holds a BARE ARRAY of records per uuid. inmetanty's
  // multiplayer.js reads `chains[uuid].records`, which is wrong and yields
  // undefined -- not repeated here.
  function detectAccount() {
    const uuid = localStorage.getItem('qip.current');
    if (!uuid) return null;
    const keystore = lsRead('qip.keystores', {})[uuid];
    if (!keystore) return null;
    const chain = lsRead('qip.chains', {})[uuid] || null;
    return { uuid: uuid, keystore: keystore, chain: chain };
  }

  // Derives the current username by validating the chain. Cheap enough to do
  // on demand and avoids trusting a cached copy that key rotation may have
  // invalidated.
  async function usernameFor(chain) {
    try {
      const state = await QIP.validateChain(chain);
      return state.username || null;
    } catch (e) {
      return null;
    }
  }

  // Unlocks the account key with the user's password. qDrive cannot work
  // without this: every QRP Offer and Answer is signed, so the private key has
  // to be in memory. It is never persisted here -- closing the tab forgets it.
  async function unlock(password) {
    const problem = secureContextProblem();
    if (problem) throw new Error(problem);

    const account = detectAccount();
    if (!account) {
      throw new Error('No Qwertious account is signed in on this device. ' +
        'Sign in at /accounts/ first, then come back.');
    }
    if (!account.chain || !account.chain.length) {
      throw new Error('This device has no cached identity chain for your account. ' +
        'Sign in at /accounts/ once so it can cache one.');
    }

    let kp;
    try {
      kp = await QIP.keystoreDecrypt(account.keystore, password);
    } catch (e) {
      throw new Error(e.reason === 'bad_password' ? 'Wrong password.' : e.message);
    }

    // A key that has been rotated away cannot sign anything the other side
    // will accept, so fail here with an explanation rather than at handshake
    // time with a signature error.
    const state = await QIP.validateChain(account.chain);
    if (state.activeKey !== kp.pub) {
      throw new Error('This device holds an old key for your account -- it was ' +
        'rotated elsewhere. Sign in again at /accounts/ to refresh it.');
    }

    P2P.identity = {
      kp: kp,
      uuid: account.uuid,
      chain: account.chain,
      username: state.username || account.uuid.slice(0, 8),
    };
    logLine('unlocked account ' + P2P.identity.username);
    return P2P.identity;
  }

  /* ------------------------------------------------------------ discovery */

  let relayDiscovery = null;
  function discoverRelayOnce() {
    if (!relayDiscovery) {
      relayDiscovery = (global.QNP && global.QNP_NODES && global.QNP_NODES.length)
        ? QNP.discoverRelay(global.QNP_NODES)
        : Promise.resolve(null);
    }
    return relayDiscovery;
  }

  let lobbyDiscovery = null;
  function discoverLobbyOnce() {
    if (!lobbyDiscovery) {
      lobbyDiscovery = (global.QNPLobby && global.QNP_NODES && global.QNP_NODES.length)
        ? QNPLobby.discoverLobby(global.QNP_NODES)
        : Promise.resolve(null);
    }
    return lobbyDiscovery;
  }

  /* ------------------------------------------------------------ transport */

  // Starts a relay allocation immediately rather than when the caller is ready
  // to race it: the relay only pairs two allocations for the same session
  // within its pairing timeout, and a human exchanging a code by hand can
  // easily take longer than that.
  function startRelayAttempt(relayUrl, allocateOpts) {
    const transport = new QNP.RelayTransport();
    const promise = transport.allocate(allocateOpts).catch((e) => {
      logLine('relay allocation failed: ' + e.message);
      throw e;
    });
    return { transport: transport, promise: promise };
  }

  // Races direct WebRTC against the relay; first to open wins, loser is closed.
  function raceForConnection(directTransport, pendingRelay) {
    return new Promise((resolve) => {
      let settled = false;
      const relayTransport = pendingRelay ? pendingRelay.transport : null;

      const finish = (winner, loser) => {
        if (settled) return;
        settled = true;
        if (loser) {
          loser.onStateChange = function () {};
          loser.onData = function () {};
          loser.close();
        }
        resolve(winner);
      };

      if (!P2P.debugForceRelayOnly) {
        directTransport.onStateChange = (state) => {
          logLine('direct: ' + state);
          if (state === 'channel-open') finish(directTransport, relayTransport);
        };
      } else {
        logLine('debugForceRelayOnly set -- ignoring direct WebRTC');
      }

      if (relayTransport) {
        relayTransport.onStateChange = (state) => {
          logLine('relay: ' + state);
          if (state === 'channel-open') {
            finish(relayTransport, P2P.debugForceRelayOnly ? null : directTransport);
          }
        };
        pendingRelay.promise
          .then(() => finish(relayTransport, P2P.debugForceRelayOnly ? null : directTransport))
          .catch(() => {}); // already logged in startRelayAttempt
      }
    });
  }

  /* --------------------------------------------------------------- frames */

  // Every frame is [kind][...]. JSON control messages and binary payloads
  // share one channel, so a file transfer does not need a second connection
  // and chunks do not have to be base64'd into JSON (which would inflate every
  // byte by a third for no benefit).
  function encodeJsonFrame(obj) {
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const frame = new Uint8Array(1 + body.length);
    frame[0] = FRAME_JSON;
    frame.set(body, 1);
    return frame;
  }

  function encodeBinaryFrame(header, payload) {
    const frame = new Uint8Array(1 + header.length + payload.length);
    frame[0] = FRAME_BINARY;
    frame.set(header, 1);
    frame.set(payload, 1 + header.length);
    return frame;
  }

  async function sendFrame(peer, frame) {
    if (!peer.connected || !peer.transport) return false;
    try {
      const sealed = await QRP.sealData(peer.keys.tx, peer.seq++, peer.session, frame);
      // Backpressure. RTCDataChannel buffers without bound and silently dies
      // when the buffer is exceeded; waiting for it to drain is what makes a
      // multi-megabyte transfer survive. The relay's WebSocket exposes no
      // equivalent, but it is a plain socket and applies its own TCP
      // backpressure, so this is only needed for the direct path.
      const channel = peer.transport.channel;
      if (channel && channel.bufferedAmount > BUFFER_HIGH_WATER) {
        await waitForDrain(channel);
      }
      return peer.transport.send(sealed);
    } catch (e) {
      logLine('send failed: ' + e.message);
      return false;
    }
  }

  const BUFFER_HIGH_WATER = 1 << 20;  // 1 MiB queued
  const BUFFER_LOW_WATER = 1 << 18;   // resume at 256 KiB

  function waitForDrain(channel) {
    return new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', onLow);
      // Safety valve: if the event never fires (channel closed mid-wait, or a
      // browser quirk), don't hang the transfer forever.
      setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', onLow);
        resolve();
      }, 5000);
    });
  }

  function sendJson(peer, obj) {
    return sendFrame(peer, encodeJsonFrame(obj));
  }

  function sendBinary(peer, header, payload) {
    return sendFrame(peer, encodeBinaryFrame(header, payload));
  }

  /* ----------------------------------------------------------------- peers */

  function wirePeer(peer) {
    peer.transport.onData = async (bytes) => {
      try {
        const plain = await QRP.openData(peer.keys.rx, peer.session, bytes, peer.replayWindow);
        if (plain.length === 0) return;
        const kind = plain[0];
        if (kind === FRAME_JSON) {
          const msg = JSON.parse(new TextDecoder().decode(plain.subarray(1)));
          emit('json', peer, msg);
        } else if (kind === FRAME_BINARY) {
          emit('binary', peer, plain.subarray(1));
        }
      } catch (e) {
        logLine('dropped a bad frame: ' + e.message);
      }
    };

    peer.transport.onStateChange = (state) => {
      logLine('connection (' + peer.uuid.slice(0, 8) + '...): ' + state);
      if (state === 'channel-open') {
        peer.connected = true;
        emit('peer', 'connected', peer);
      }
      if (state === 'channel-closed' || state === 'failed' || state === 'disconnected' ||
          String(state).indexOf('ice-failed') === 0) {
        const was = peer.connected;
        peer.connected = false;
        if (was) {
          delete P2P.peers[peer.uuid];
          emit('peer', 'disconnected', peer);
        }
      }
    };

    // The winning transport already fired channel-open during the race, to a
    // temporary handler; re-fire it against the real one or connected never
    // flips true.
    peer.transport.onStateChange('channel-open');
  }

  async function verifyPeerChain(chainRecords, expectedUuid) {
    const state = await QIP.validateChain(chainRecords);
    if (expectedUuid && state.uuid !== expectedUuid) {
      throw new Error('chain uuid does not match the message that referenced it');
    }
    return state;
  }

  /* ------------------------------------------------------- offer / answer */

  async function buildOffer(extra) {
    const eph = await QRP.x25519Keypair();
    const transport = new QRPTransport.PeerConnection();
    const sdp = await transport.createOffer();
    const offer = await QRP.makeOffer({
      uuid: P2P.identity.uuid, aud: AUD, kpIdentity: P2P.identity.kp,
      ephemeralPub: eph.pub, candidates: [], extra: extra,
    });

    const peer = {
      uuid: null, transport: transport, ephPriv: eph.priv, session: offer.session,
      keys: null, replayWindow: null, seq: 0, connected: false,
    };
    peer._pendingRelay = P2P.relayUrl ? startRelayAttempt(P2P.relayUrl, {
      wsUrl: P2P.relayUrl, uuid: P2P.identity.uuid, aud: 'urn:qnp:relay',
      kpIdentity: P2P.identity.kp, session: offer.session, chain: P2P.identity.chain,
    }) : null;

    P2P.pendingOutbound[offer.session] = peer;
    logLine('offer created, session ' + offer.session.slice(0, 8) + '...');
    return { offer: offer, sdp: sdp };
  }

  // Offerer side: an Answer came back.
  async function completeWithAnswer(parsed) {
    const sessionId = parsed.qrp.in_reply_to;
    const peer = P2P.pendingOutbound[sessionId];
    if (!peer) {
      throw new Error('That reply does not match a pending connection attempt -- ' +
        'it may already have been used, or the offer expired.');
    }
    delete P2P.pendingOutbound[sessionId];

    const state = await verifyPeerChain(parsed.chain, parsed.qrp.uuid);
    await QRP.verifyRendezvous(parsed.qrp, state, {
      aud: AUD, expectedTyp: 'rendezvous-answer',
      nonces: new QRP.NonceTracker(), inReplyTo: sessionId,
    });

    // The access-control check, offerer side: only ever talk to our own
    // account's devices.
    if (parsed.qrp.uuid !== P2P.identity.uuid) {
      peer.transport.close();
      throw new Error('That device belongs to a different Qwertious account.');
    }
    logLine('answer verified -- same account, connecting');

    await peer.transport.acceptAnswer(parsed.sdp);
    const theirEph = QRP.x25519PubRaw(parsed.qrp.ephemeral);
    peer.keys = await QRP.deriveSessionKeys(peer.ephPriv, theirEph, sessionId, true);
    peer.replayWindow = new QRP.ReplayWindow();
    peer.uuid = parsed.qrp.uuid;

    const relayUrl = parsed.qrp.relay || P2P.relayUrl || null;
    const pendingRelay = (relayUrl && relayUrl === P2P.relayUrl) ? peer._pendingRelay
      : (relayUrl ? startRelayAttempt(relayUrl, {
        wsUrl: relayUrl, uuid: P2P.identity.uuid, aud: 'urn:qnp:relay',
        kpIdentity: P2P.identity.kp, session: sessionId, chain: P2P.identity.chain,
      }) : null);

    peer.transport = await raceForConnection(peer.transport, pendingRelay);
    P2P.peers[peer.uuid] = peer;
    wirePeer(peer);
    return peer;
  }

  // Responder side: an Offer arrived. Returns the Answer to send back.
  async function answerOffer(parsed) {
    const state = await verifyPeerChain(parsed.chain, parsed.qrp.uuid);
    await QRP.verifyRendezvous(parsed.qrp, state, {
      aud: AUD, expectedTyp: 'rendezvous-offer', nonces: new QRP.NonceTracker(),
    });

    // The access-control check, responder side. This is the one that matters:
    // it is what stops a stranger who saw the public listing from connecting.
    if (parsed.qrp.uuid !== P2P.identity.uuid) {
      logLine('rejected a connection from a different account (' +
        parsed.qrp.uuid.slice(0, 8) + '...)');
      throw new Error('different account');
    }
    logLine('offer verified -- same account, answering');

    const eph = await QRP.x25519Keypair();
    const transport = new QRPTransport.PeerConnection();
    const answerSdp = await transport.acceptOfferAndAnswer(parsed.sdp);
    const answer = await QRP.makeAnswer({
      offer: parsed.qrp, uuid: P2P.identity.uuid, aud: AUD,
      kpIdentity: P2P.identity.kp, ephemeralPub: eph.pub, candidates: [],
      extra: P2P.relayUrl ? { relay: P2P.relayUrl } : undefined,
    });

    const theirEph = QRP.x25519PubRaw(parsed.qrp.ephemeral);
    const peer = {
      uuid: parsed.qrp.uuid, transport: transport,
      keys: await QRP.deriveSessionKeys(eph.priv, theirEph, parsed.qrp.session, false),
      session: parsed.qrp.session, replayWindow: new QRP.ReplayWindow(),
      seq: 0, connected: false,
    };

    const relayUrl = parsed.qrp.relay || P2P.relayUrl || null;
    const pendingRelay = relayUrl ? startRelayAttempt(relayUrl, {
      wsUrl: relayUrl, uuid: P2P.identity.uuid, aud: 'urn:qnp:relay',
      kpIdentity: P2P.identity.kp, session: parsed.qrp.session, chain: P2P.identity.chain,
    }) : null;

    // Fire and forget: the caller needs the answer back immediately so it can
    // be posted, so the connection race must not block returning it.
    raceForConnection(transport, pendingRelay).then((winner) => {
      peer.transport = winner;
      P2P.peers[peer.uuid] = peer;
      wirePeer(peer);
    });

    return { answer: answer, sdp: answerSdp };
  }

  /* ---------------------------------------------------------- manual codes */

  function packBlob(qrpMsg, sdp) {
    const payload = { qrp: qrpMsg, sdp: sdp, chain: P2P.identity.chain };
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }

  function unpackBlob(code) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(String(code).trim()))));
    } catch (e) {
      throw new Error('That code is not valid (' + e.message + ')');
    }
  }

  function expectBlobType(parsed, expectedTyp) {
    const got = parsed && parsed.qrp && parsed.qrp.typ;
    if (got === expectedTyp) return;
    if (expectedTyp === 'rendezvous-answer' && got === 'rendezvous-offer') {
      throw new Error('That is a connection code, not a reply code. Paste it on ' +
        'the OTHER device, under "I have a code from my other device".');
    }
    if (expectedTyp === 'rendezvous-offer' && got === 'rendezvous-answer') {
      throw new Error('That is a reply code, not a connection code. It belongs on ' +
        'the device that generated the first code.');
    }
    throw new Error('That does not look like a qDrive code at all.');
  }

  /* ---------------------------------------------------------- lobby flows */

  // Puts up a listing and answers connection attempts from this account's own
  // devices for as long as it stays up. Returns { stop }.
  async function startSharing(opts) {
    opts = opts || {};
    if (!P2P.identity) throw new Error('Unlock your account first.');

    P2P.relayUrl = await discoverRelayOnce();
    P2P.lobbyBase = await discoverLobbyOnce();
    if (!P2P.lobbyBase) {
      throw new Error('No qSuite node is reachable to publish through. ' +
        'Use a connection code instead.');
    }

    const hosting = QNPLobby.startHosting(P2P.lobbyBase, {
      game: 'qdrive',
      uuid: P2P.identity.uuid,
      kpIdentity: P2P.identity.kp,
      chain: P2P.identity.chain,
      title: opts.deviceName || 'A device',
      players: () => ({ current: Object.keys(P2P.peers).length + 1 }),
      password: null,
      onOffer: async (entry) => {
        try {
          const parsed = { qrp: entry.offer.qrp, sdp: entry.offer.sdp, chain: entry.chain };
          const result = await answerOffer(parsed);
          await QNPLobby.submitAnswer(P2P.lobbyBase, {
            session: entry.session,
            answer: { qrp: result.answer, sdp: result.sdp },
            chain: P2P.identity.chain,
          });
        } catch (e) {
          // A rejected stranger is expected traffic, not an error worth
          // surfacing to the user.
          if (e.message !== 'different account') {
            logLine('a connection attempt failed: ' + e.message);
          }
        }
      },
    });

    P2P.sharing = hosting;
    logLine('this device is now discoverable to your other devices');
    return hosting;
  }

  function stopSharing() {
    if (P2P.sharing) {
      P2P.sharing.stop();
      P2P.sharing = null;
      logLine('stopped sharing (existing connections stay up)');
    }
  }

  // Finds this account's OWN listing and connects to it.
  async function connectToMyDevice() {
    if (!P2P.identity) throw new Error('Unlock your account first.');

    P2P.relayUrl = await discoverRelayOnce();
    P2P.lobbyBase = await discoverLobbyOnce();
    if (!P2P.lobbyBase) {
      throw new Error('No qSuite node is reachable. Use a connection code instead.');
    }

    const entries = await QNPLobby.list(P2P.lobbyBase, 'qdrive');
    const mine = entries.find((e) => e.uuid === P2P.identity.uuid);
    if (!mine) {
      throw new Error('None of your other devices is sharing right now. ' +
        'On the other device, open qDrive and turn on "Share this device".');
    }

    const { offer, sdp } = await buildOffer(P2P.relayUrl ? { relay: P2P.relayUrl } : undefined);
    await QNPLobby.submitOffer(P2P.lobbyBase, {
      hostUuid: mine.uuid, session: offer.session,
      offer: { qrp: offer, sdp: sdp }, chain: P2P.identity.chain, password: null,
    });
    logLine('connection request sent -- waiting for your other device...');

    const result = await QNPLobby.pollUntilAnswered(P2P.lobbyBase, offer.session);
    if (!result) {
      delete P2P.pendingOutbound[offer.session];
      throw new Error('Your other device did not answer. It may have gone offline.');
    }
    return completeWithAnswer({
      qrp: result.answer.qrp, sdp: result.answer.sdp, chain: result.chain,
    });
  }

  /* -------------------------------------------------------------- exports */

  global.QSuiteP2P = {
    state: P2P,
    AUD: AUD,
    on: on,
    log: logLine,
    secureContextProblem: secureContextProblem,
    detectAccount: detectAccount,
    usernameFor: usernameFor,
    unlock: unlock,

    startSharing: startSharing,
    stopSharing: stopSharing,
    connectToMyDevice: connectToMyDevice,

    // Manual fallback, for when no node is reachable.
    async createConnectionCode() {
      if (!P2P.identity) throw new Error('Unlock your account first.');
      P2P.relayUrl = await discoverRelayOnce();
      const { offer, sdp } = await buildOffer(P2P.relayUrl ? { relay: P2P.relayUrl } : undefined);
      return packBlob(offer, sdp);
    },
    async acceptConnectionCode(code) {
      if (!P2P.identity) throw new Error('Unlock your account first.');
      P2P.relayUrl = await discoverRelayOnce();
      const parsed = unpackBlob(code);
      expectBlobType(parsed, 'rendezvous-offer');
      const result = await answerOffer(parsed);
      return packBlob(result.answer, result.sdp);
    },
    async completeWithReplyCode(code) {
      const parsed = unpackBlob(code);
      expectBlobType(parsed, 'rendezvous-answer');
      return completeWithAnswer(parsed);
    },

    sendJson: sendJson,
    sendBinary: sendBinary,
    peerList: () => Object.values(P2P.peers).filter((p) => p.connected),
    forceRelayOnly: (v) => { P2P.debugForceRelayOnly = !!v; },
  };
})(window);
