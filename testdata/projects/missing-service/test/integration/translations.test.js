'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

// The test environment names the translation store, as the project's own
// tests do with their env file. The Run does not start it, so the request
// must fail with a lookup error, not run into the 5 s Mocha timeout below.
function translationHost() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.test.env'), 'utf8');
  return /^TRANSLATION_HOST=(.+)$/m.exec(env)[1];
}

// A store client that keeps its connection up, as real clients do: when the
// connection closes it connects again at once. With the store missing it never
// stops, so the run ends with its socket still open.
function keepConnected(url) {
  const { hostname, port } = new URL(url);
  const socket = net.connect({ host: hostname, port: Number(port) });
  socket.on('error', () => {});
  socket.on('close', () => keepConnected(url));
}

describe('translations', function () {
  this.timeout(5000);

  it('are read from the translation store', (done) => {
    keepConnected(translationHost());
    http
      .get(translationHost(), { timeout: 5000 }, () => done())
      .on('error', done);
  });
});
