/*
 * qsuite-config.js -- network configuration for the suite.
 * Load AFTER transport-webrtc.js (it calls into it) and before qsuite-p2p.js.
 */
(function (global) {
  'use strict';

  // QNP nodes to ask for relay and lobby capability, in order. These are HTTP
  // base URLs, not WebSocket URLs -- discovery fetches /qip/v1/node from each.
  //
  // Empty by default: point this at your own node, e.g.
  // ['https://qnp.example.org']. Without one, qDocs needs no network at all
  // and qDrive falls back to connection codes.
  global.QNP_NODES = [];

  // No third-party TURN.
  //
  // transport-webrtc.js defaults to the Open Relay Project's public demo TURN
  // servers when none is configured -- fine for a game, wrong here. qDrive
  // moves the user's own files, and the honest promise of "no cloud" means not
  // silently routing them through a stranger's infrastructure. QRP seals every
  // frame end-to-end so a relay only ever sees ciphertext either way, but the
  // fallback path should still be infrastructure the operator runs.
  //
  // This must be a call, not just an empty QRP_TURN_SERVERS: that file treats
  // an empty array as "not configured" and falls back to the defaults anyway.
  // configureTurnServers([]) sets STUN-only, leaving the QNP relay as the one
  // fallback when a direct connection cannot be made.
  if (global.QRPTransport && global.QRPTransport.configureTurnServers) {
    global.QRPTransport.configureTurnServers([]);
  }
})(window);
