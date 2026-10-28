'use strict';

const assert = require('node:assert');
const { banner } = require('../src/typed');
const { double } = require('../src/untyped');

describe('typed-js', () => {
  it('draws a banner', () => {
    assert.strictEqual(banner(3), '---');
  });

  it('doubles', () => {
    assert.strictEqual(double(2), 4);
  });
});
