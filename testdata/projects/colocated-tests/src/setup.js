'use strict';

// A root hook plugin: Mocha loads this file through the config's `require`
// before any spec, and it uses nothing but the assertion module.
const assert = require('node:assert');

exports.mochaHooks = {
  beforeEach() {
    assert.ok(true);
  },
};
