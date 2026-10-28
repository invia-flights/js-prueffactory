'use strict';

const assert = require('node:assert');
const { banner } = require('../src/index.js');

describe('banner', () => {
  it('repeats the line break', () => {
    assert.strictEqual(banner(2), '\n\n');
  });
});
