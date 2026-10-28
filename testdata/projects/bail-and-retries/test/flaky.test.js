'use strict';

const assert = require('node:assert');
const { add } = require('../src/index');

// A test that fails on its first attempt and passes on its second: it counts
// as passed, and the retry shows that it is flaky.
let attempts = 0;

describe('flaky', () => {
  it('passes only on its second attempt', function () {
    this.retries(2);
    attempts += 1;
    assert.strictEqual(add(1, attempts), 3);
  });

  it('passes at once', () => {
    assert.strictEqual(add(2, 2), 4);
  });
});
