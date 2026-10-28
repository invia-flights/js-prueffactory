'use strict';

function add(/** @type {number} */ a, /** @type {number} */ b) {
  return a + b;
}

// No test calls this function, so the project's function coverage is below
// 100 percent.
function subtract(/** @type {number} */ a, /** @type {number} */ b) {
  return a - b;
}

module.exports = { add, subtract };
