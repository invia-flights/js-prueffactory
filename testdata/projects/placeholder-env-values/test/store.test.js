'use strict';

const assert = require('node:assert');
const { list } = require('../src/index');

describe('store', () => {
  it('answers an empty list', () => {
    // Fails on purpose, so the Report holds this test's title and its re-run
    // command. The message quotes a made-up token of the .env file.
    assert.deepStrictEqual(list(), ['item'], 'listing with Qm7vR2xKp9LzT4wYb8NcJ3dH');
  });
});
