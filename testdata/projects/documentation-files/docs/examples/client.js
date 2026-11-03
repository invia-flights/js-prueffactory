'use strict';

// A runnable example. The duplicate key is a real no-dupe-keys hit, so the
// example is still linted although it lies below docs/.
const options = {
  host: 'localhost',
  host: 'orders.internal.invalid',
  retries: 2,
};

module.exports = { options };
