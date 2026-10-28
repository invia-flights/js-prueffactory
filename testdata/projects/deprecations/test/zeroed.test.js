'use strict';

const assert = require('node:assert');
const { zeroed } = require('../src/index');

describe('zeroed', () => {
  it('returns a buffer of zeros', () => {
    assert.deepStrictEqual([...zeroed(3)], [0, 0, 0]);
  });
});
