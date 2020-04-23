'use strict';

if (typeof window !== 'undefined') {
  window._WebSocket = window.WebSocket;
}

const ZitiWebSocket = require('./lib/ziti-websocket');

ZitiWebSocket.Receiver = require('./lib/receiver');
ZitiWebSocket.Sender = require('./lib/sender');

if (typeof window !== 'undefined') {
  window.WebSocket = ZitiWebSocket;
}

module.exports = ZitiWebSocket;
