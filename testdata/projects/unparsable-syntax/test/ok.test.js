'use strict';

const assert = require('node:assert');
const { reset } = require('../src/ok.js');

describe('reset', () => {
  it('keeps the count', () => {
    assert.strictEqual(reset({ count: 1 }).count, 1);
  });
});
