'use strict';

const assert = require('node:assert');
const { add } = require('../src/index');

describe('add', () => {
  // A leftover from debugging: Mocha runs only this test and skips the others.
  it.only('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it('adds negative numbers', () => {
    assert.strictEqual(add(-2, -3), -5);
  });

  it('adds zero');
});
