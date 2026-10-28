'use strict';

const assert = require('node:assert');
const { add } = require('../src/index');

describe('math', () => {
  it('is commutative', () => {
    assert.strictEqual(add(1, 2), add(2, 1));
  });
});
