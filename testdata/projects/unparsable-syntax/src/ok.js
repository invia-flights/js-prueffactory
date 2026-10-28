'use strict';

// Parses fine and holds one hit of no-self-assign, which stays a Finding.
function reset(state) {
  state.count = state.count;
  return state;
}

module.exports = { reset };
