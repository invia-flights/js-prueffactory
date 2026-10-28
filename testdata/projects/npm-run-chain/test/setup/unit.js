'use strict';

const net = require('node:net');
const { unitMarker } = require('../../src/unit-only');

exports.mochaHooks = {
  beforeAll() {
    this.layer = unitMarker();
    // Left open on purpose: nothing closes this server, so the unit suite ends
    // with a listening TCP server.
    this.server = net.createServer().listen(0, '127.0.0.1');
  },
};
