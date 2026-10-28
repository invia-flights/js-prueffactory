'use strict';

const { alpha } = require('./cycle-a');

function beta(depth) {
  return depth > 0 ? alpha(depth - 1) : 'b';
}

module.exports = { beta };
