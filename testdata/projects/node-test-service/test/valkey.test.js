'use strict';

const assert = require('node:assert');
const net = require('node:net');
const { describe, it } = require('node:test');

// One command over the RESP protocol, with no dependencies: the Service is
// reached under its compose service name, redis, the way the project's own
// configuration would.
function command(...words) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: process.env.REDIS_HOST || 'redis', port: 6379 });
    let reply = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      reply += chunk;
      if (reply.endsWith('\r\n')) {
        socket.end();
      }
    });
    socket.on('close', () => resolve(reply.trim()));
    socket.write(`*${words.length}\r\n` + words.map((w) => `$${Buffer.byteLength(w)}\r\n${w}\r\n`).join(''));
  });
}

describe('valkey service under node:test', () => {
  it('answers PING under the compose service name', async () => {
    assert.strictEqual(await command('PING'), '+PONG');
  });

  it('starts empty', async () => {
    assert.strictEqual(await command('DBSIZE'), ':0');
  });
});
