'use strict';

function add(a, b) {
  return a + b;
}

// No test calls this function, so the project's function coverage is below
// 100 percent.
function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
