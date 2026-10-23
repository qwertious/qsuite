/*
 * transport-webrtc.js -- the actual P2P transport for browser QRP.
 *
 * QRP's SPEC-v1.md section 7/8 (raw UDP candidates, hole punching) assumes a
 * native client with socket access. A browser page cannot open a raw UDP
 * socket at all -- the only real peer-to-peer transport available to
 * JavaScript is WebRTC's RTCDataChannel, which does its own ICE gathering
 * and NAT traversal internally (using STUN, same idea as QRP section 7.1,
 * just already implemented by the browser).
 *
 * So the division of labor here is: WebRTC handles "how do these two
 * browsers actually reach each other" (real NAT traversal, real STUN). QRP
 * handles "which QIP identity is on each end, and an independent encryption
 * layer keyed to that identity" -- riding on top of, not replacing, WebRTC's
 * own DTLS encryption. That second layer is not redundant even though DTLS
 * already secures the channel: it authenticates the channel to a specific
 * player's persistent identity, not just "some WebRTC peer that answered
 * the signaling exchange," which matters if the signaling exchange itself
 * could be tampered with (e.g. a copy-pasted code altered in transit).
 *
 * The WebRTC SDP offer/answer rides inside the same QRP Offer/Answer
 * message that carries identity proof -- one signaling exchange, not two.
 *
 * ============================================================================
 * STUN alone is not enough. This is the real, disclosed limitation from
 * QRP's SPEC-v1.md section 12.4, not a bug: STUN only helps two peers find
 * each other's PUBLIC address. If either side is behind a NAT that assigns a
 * different external port per destination ("symmetric NAT" -- common on
 * mobile carriers and some routers/firewalls), the address STUN reports is
 * useless for reaching that peer specifically, and there is no direct path
 * at all. WebRTC then reports ICE failure -- Firefox's exact wording is
 * "ICE failed, add a TURN server and see about:webrtc for more details",
 * which is the browser correctly telling you what's missing.
 *
 * A TURN server is the fix: an actual relay both sides can reach (unlike a
 * symmetric NAT, a plain server with a public IP has no such restriction),
 * so ICE falls back to relaying through it when a direct path can't be
 * found. This is the SAME "opaque relay, last resort" idea QRP's own spec
 * sketches in section 11 for a native client -- WebRTC already implements
 * that concept as a first-class part of ICE, so no separate relay protocol
 * needs to be invented here; a TURN server just needs to be configured.
 *
 * DEFAULT_TURN below is a well-known, publicly documented, no-signup TURN
 * service (Open Relay Project) meant for exactly this: unblocking testing
 * immediately. It is free-tier, rate-limited, and run by a third party --
 * fine to develop against, not something to depend on permanently. See
 * multiplayer/TURN.md for self-hosting coturn on your own server instead,
 * which is the sustainable answer and consistent with everything else in
 * this project being self-hostable rather than a third-party dependency.
 */
(function (global) {
  'use strict';

  const DEFAULT_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Open Relay Project's published, no-signup-required demo TURN credentials
  // (openrelay.metered.ca) -- publicly documented for exactly this purpose.
  // Rate-limited and not guaranteed to stay available; swap for a self-hosted
  // coturn server (see TURN.md) before relying on this for real.
  const DEFAULT_TURN = [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // turn-config.js (loaded before this file) is where a self-hosted TURN
  // server actually gets configured -- see TURN.md. Falls back to the public
  // Open Relay Project default only if that file is missing/empty, so a
  // third-party dependency is never the only option, just the zero-setup one.
  const ownTurn = (global.QRP_TURN_SERVERS && global.QRP_TURN_SERVERS.length) ?
    global.QRP_TURN_SERVERS : null;
  if (!ownTurn) {
    console.warn('[QRP] No TURN server configured in turn-config.js -- using the public ' +
      'Open Relay Project default, which is rate-limited and not guaranteed to stay up. ' +
      'See multiplayer/TURN.md.');
  }

  let iceServers = DEFAULT_STUN.concat(ownTurn || DEFAULT_TURN);

  // Call this at runtime to change TURN servers without a page reload (e.g.
  // from a dev console while testing). Pass [] to disable TURN entirely and
  // fall back to STUN-only -- that combination is what silently produced
  // "ICE failed" with no relay to fall back to, before this file had any
  // TURN configured at all.
  function configureTurnServers(turnServers) {
    iceServers = DEFAULT_STUN.concat(turnServers || []);
  }

  class PeerConnection {
    constructor(onData, onStateChange) {
      this.pc = new RTCPeerConnection({ iceServers: iceServers });
      this.channel = null;
      this.onData = onData || function () {};
      this.onStateChange = onStateChange || function () {};
      this.pc.onconnectionstatechange = () => this.onStateChange(this.pc.connectionState);
      this.pc.oniceconnectionstatechange = () => {
        if (this.pc.iceConnectionState === 'failed') {
          const hasTurn = iceServers.some((s) =>
            (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.indexOf('turn:') === 0));
          this.onStateChange('ice-failed' + (hasTurn ? ' (TURN was configured and still failed -- ' +
            'check the TURN server itself, e.g. about:webrtc in Firefox)' :
            ' (no TURN server configured, and STUN alone could not find a direct path)'));
        }
      };
    }

    _wireChannel(channel) {
      this.channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (e) => this.onData(new Uint8Array(e.data));
      channel.onopen = () => this.onStateChange('channel-open');
      channel.onclose = () => this.onStateChange('channel-closed');
    }

    // Gathers ICE candidates and waits for them to finish (non-trickle, same
    // simplification QRP's own spec makes for the same reason -- one round
    // trip instead of a streaming exchange, acceptable for a game session
    // that isn't renegotiating mid-flight).
    async _waitForIceGathering() {
      if (this.pc.iceGatheringState === 'complete') return;
      await new Promise((resolve) => {
        const check = () => {
          if (this.pc.iceGatheringState === 'complete') {
            this.pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        this.pc.addEventListener('icegatheringstatechange', check);
        // Don't hang forever on a network that can't reach any STUN server --
        // fall back to whatever host candidates were gathered so far.
        setTimeout(resolve, 4000);
      });
    }

    // Initiator side: create the data channel and an SDP offer.
    async createOffer() {
      this._wireChannel(this.pc.createDataChannel('qrp-data', { ordered: true }));
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this._waitForIceGathering();
      return this.pc.localDescription.sdp;
    }

    // Responder side: accept the initiator's SDP, produce an SDP answer.
    async acceptOfferAndAnswer(remoteSdp) {
      this.pc.ondatachannel = (e) => this._wireChannel(e.channel);
      await this.pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this._waitForIceGathering();
      return this.pc.localDescription.sdp;
    }

    // Initiator side: accept the responder's SDP answer to complete the handshake.
    async acceptAnswer(remoteSdp) {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });
    }

    send(bytes) {
      if (this.channel && this.channel.readyState === 'open') {
        this.channel.send(bytes);
        return true;
      }
      return false;
    }

    close() {
      if (this.channel) this.channel.close();
      this.pc.close();
    }
  }

  global.QRPTransport = { PeerConnection: PeerConnection, configureTurnServers: configureTurnServers };
})(window);
