'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');
const { label } = require('../src/index');

describe('label', () => {
  it('names one finding', () => {
    assert.strictEqual(label(1), '1 finding');
  });

  it('counts several findings', () => {
    assert.strictEqual(label(3), '3 findings');
  });
});
