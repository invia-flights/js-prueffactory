'use strict';

function add(a, b) {
  return a + b;
}

function describeSum(a, b) {
  return `${a} + ${b} = ${add(a, b)}`;
}

module.exports = { add, describeSum };
