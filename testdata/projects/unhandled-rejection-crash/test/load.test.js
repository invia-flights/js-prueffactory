'use strict';

const assert = require('node:assert');

// The project logs what it cannot handle, so a rejection never stops the run.
process.on('unhandledRejection', (reason) => {
  console.log('unhandled rejection logged:', reason && reason.message);
});

// Nobody handles this promise, and it rejects while the file loads, before any
// test runs.
Promise.reject(new Error('the setup call failed while the file loads'));

describe('load', () => {
  it('adds', () => {
    assert.strictEqual(1 + 1, 2);
  });

  it('subtracts', () => {
    assert.strictEqual(3 - 1, 2);
  });
});
