'use strict';

const assert = require('node:assert');
const { add } = require('../src/index');

describe('failures', () => {
  // With bail on, Mocha would stop here and hide everything after it.
  it('fails first', () => {
    assert.strictEqual(add(2, 3), 6);
  });

  it('still runs after a failure', () => {
    assert.strictEqual(add(1, 1), 2);
  });

  it('fails on every attempt', function () {
    this.retries(2);
    assert.strictEqual(add(1, 1), 3);
  });
});
