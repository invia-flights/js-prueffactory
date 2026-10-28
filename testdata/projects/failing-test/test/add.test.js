'use strict';

const assert = require('node:assert');
const { add } = require('../src/index');

describe('add', () => {
  it('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it('adds negative numbers', () => {
    // Fails on purpose: -1 + -1 is -2.
    assert.strictEqual(add(-1, -1), 2);
  });
});
