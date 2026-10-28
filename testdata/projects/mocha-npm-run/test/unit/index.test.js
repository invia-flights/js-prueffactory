'use strict';

const assert = require('node:assert');

describe('next', () => {
  let value;

  before(() => {
    value = 1;
  });

  beforeEach(() => {
    value += 1;
  });

  afterEach(() => {
    value -= 1;
  });

  it('adds one', () => {
    assert.strictEqual(value + 1, 3);
  });
});
