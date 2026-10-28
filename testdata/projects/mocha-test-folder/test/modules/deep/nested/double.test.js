'use strict';

const assert = require('node:assert');
const { double } = require('../../../../src/lib/double');

describe('double', () => {
  it('doubles', () => {
    assert.strictEqual(double(2), 4);
  });
});
