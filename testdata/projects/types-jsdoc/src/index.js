'use strict';

const os = require('node:os');

/**
 * @param {number} count how many lines to print
 * @returns {string}
 */
function banner(count) {
  return os.EOL.repeat(count);
}

// The JSDoc above says a number: the call in `wrong` breaks that contract.
module.exports = { banner, wrong: banner('3'), cwd: process.cwd() };

// Node resolves this to data/schema.json: not a missing module.
const schema = require('./data/schema');

// Neither ./data/missing.js nor ./data/missing.json exists: a real broken require.
function loadMissing() {
  return require('./data/missing');
}
