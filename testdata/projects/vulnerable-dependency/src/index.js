'use strict';

const minimist = require('minimist');

module.exports = function parse(argv) {
  return minimist(argv);
};
