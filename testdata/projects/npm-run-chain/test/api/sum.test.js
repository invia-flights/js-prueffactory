'use strict';

const assert = require('node:assert');
const { describeSum } = require('../../src/index');

describe('describeSum', () => {
  it('describes a sum', () => {
    assert.strictEqual(describeSum(1, 2), '1 + 2 = 3');
  });

  it('describes a sum with the wrong text', () => {
    assert.strictEqual(describeSum(2, 2), '2 + 2 = 5');
  });
});
