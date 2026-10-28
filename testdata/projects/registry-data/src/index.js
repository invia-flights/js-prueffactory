'use strict';

const leftPad = require('left-pad');

module.exports = function pad(text) {
  return leftPad(text, 8);
};
