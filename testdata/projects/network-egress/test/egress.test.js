'use strict';

const assert = require('node:assert');
const dns = require('node:dns');
const net = require('node:net');

// A test that reaches a real system by accident would pass on a laptop and
// fail in the Execution phase. This one expects every outbound attempt to fail.
describe('outbound network', () => {
  it('refuses a TCP connection to a public address', (done) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.destroy();
      done(new Error('connected to 1.1.1.1:443'));
    });
    socket.on('timeout', () => {
      socket.destroy();
      done();
    });
    socket.on('error', () => done());
  });

  it('cannot resolve a public host name', (done) => {
    dns.lookup('example.com', (err, address) => {
      assert.ok(err, `example.com resolved to ${address}`);
      done();
    });
  });
});
