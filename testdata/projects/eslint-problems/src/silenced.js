'use strict';

// The same hit as in index.js, hidden behind a comment. The combined run
// ignores inline comments, so it is found anyway.
function reset(state) {
  // eslint-disable-next-line no-self-assign
  state.count = state.count;
  return state;
}

module.exports = { reset };
