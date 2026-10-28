'use strict';

const assert = require('node:assert');
const ok = require('../src/ok');

describe('ok', () => {
  it('is true', () => {
    assert.strictEqual(ok(), true);
  });
});
