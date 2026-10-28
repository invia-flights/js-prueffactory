'use strict';

const assert = require('node:assert');
const { subtract } = require('../src/index');

describe('subtract', () => {
  it('subtracts two numbers', () => {
    assert.strictEqual(subtract(5, 3), 2);
  });
});
