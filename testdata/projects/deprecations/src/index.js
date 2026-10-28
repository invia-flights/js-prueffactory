'use strict';

// The constructor Buffer() is deprecated: depending on its argument it hands
// out uninitialised memory. Buffer.alloc() is the replacement.
function zeroed(size) {
  return new Buffer(size).fill(0);
}

module.exports = { zeroed };
