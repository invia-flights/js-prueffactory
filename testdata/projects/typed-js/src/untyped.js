'use strict';

// No JSDoc: under strict mode the parameter is an implicit any, which is the
// one error that only the strict run reports.
function double(value) {
  return value * 2;
}

module.exports = { double };
