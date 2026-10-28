'use strict';

// mocha is only a devDependency, so this fails where only production
// dependencies are installed.
const Mocha = require('mocha');
const { reporterName } = require('./lazy');

function start() {
  return { mocha: typeof Mocha, reporter: reporterName() };
}

module.exports = { start };
