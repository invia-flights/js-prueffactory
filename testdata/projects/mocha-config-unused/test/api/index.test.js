'use strict';

const assert = require('node:assert');
const { add } = require('../../src');

describe('api', () => {
  it('adds', () => {
    assert.strictEqual(add(1, 2), 3);
  });
});
