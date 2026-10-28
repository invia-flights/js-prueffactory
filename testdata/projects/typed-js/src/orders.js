'use strict';

// Async mistakes for lint.typed. Every parameter is typed, so that nothing here
// is reported by types.strictness.

/**
 * @param {number} id
 * @returns {Promise<number>}
 */
async function save(id) {
  return id;
}

/**
 * The promise of the first call is dropped.
 * @param {number} id
 */
function saveTwice(id) {
  save(id);
  return save(id + 1);
}

/**
 * The same mistake behind a disable comment, which the Check ignores.
 * @param {number} id
 */
function saveQuietly(id) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  save(id);
}

/**
 * forEach expects a callback that returns nothing, and gets one that returns a
 * promise.
 * @param {number[]} ids
 */
function saveEach(ids) {
  ids.forEach(async (id) => {
    await save(id);
  });
}

/**
 * Awaiting a number is not awaiting a promise.
 * @param {number} id
 * @returns {Promise<number>}
 */
async function double(id) {
  return (await id) * 2;
}

module.exports = { save, saveTwice, saveQuietly, saveEach, double };
