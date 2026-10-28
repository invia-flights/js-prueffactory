'use strict';

const { beta } = require('./cycle-b');

function alpha(depth) {
  return depth > 0 ? beta(depth - 1) : 'a';
}

function unusedExport() {
  return 'nobody calls this';
}

module.exports = { alpha, unusedExport };
