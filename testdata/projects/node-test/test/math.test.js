'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { add, subtract } = require('../src/index');

describe('math', () => {
  it('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it('subtracts two numbers', () => {
    assert.strictEqual(subtract(5, 3), 2);
  });

  it('multiplies two numbers', { todo: 'multiply is not written yet' }, () => {
    assert.fail('not implemented');
  });
});
