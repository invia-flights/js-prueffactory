'use strict';

const { apiMarker } = require('../../src/api-only');

exports.mochaHooks = {
  beforeAll() {
    this.layer = apiMarker();
  },
};
