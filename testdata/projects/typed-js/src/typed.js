'use strict';

/**
 * @param {number} count how many dashes to draw
 * @returns {string}
 */
function banner(count) {
  return '-'.repeat(count);
}

/**
 * @param {string} name
 * @param {number} age
 * @returns {{ name: string, age: number }}
 */
function person(name, age) {
  return { name, age };
}

module.exports = { banner, person };
