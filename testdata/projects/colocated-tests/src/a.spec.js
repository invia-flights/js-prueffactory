'use strict';

const assert = require('node:assert');
const { add } = require('./index');

describe('add', () => {
  it('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
  });
});
