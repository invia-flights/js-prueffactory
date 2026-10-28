'use strict';

exports.mochaHooks = {
  beforeEach() {
    this.startedAt = Date.now();
  },
};
