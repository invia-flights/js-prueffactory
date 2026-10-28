'use strict';

const assert = require('node:assert');
const { add } = require('../../src/index');

describe('add', () => {
  it('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it('adds negative numbers', () => {
    assert.strictEqual(add(-2, -3), -5);
  });
});
