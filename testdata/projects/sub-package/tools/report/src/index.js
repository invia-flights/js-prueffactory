'use strict';

function label(count) {
  return count === 1 ? '1 finding' : `${count} findings`;
}

module.exports = { label };
