'use strict';

// no-self-assign: the value is assigned to itself.
function reset(state) {
  state.count = state.count;
  return state;
}

module.exports = { reset };
