'use strict';

/**
 * @param {number} count how many lines to print
 * @returns {string}
 */
function banner(count) {
  return '\n'.repeat(count);
}

// The JSDoc above says a number: the call in `wrong` breaks that contract.
module.exports = { banner, wrong: banner('3') };
