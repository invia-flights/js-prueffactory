'use strict';

const assert = require('node:assert');
const { start } = require('../src/server');

describe('server', () => {
  it('answers on a free port', async () => {
    const server = await start();
    assert.ok(server.address().port > 0);
    // The server is never closed: after the last test the process keeps
    // running, because Mocha is not told to exit.
  });
});
