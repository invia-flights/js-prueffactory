'use strict';

// no-unused-vars: `_next` is unused on purpose, as in an Express error handler,
// and its underscore says so. `leftover` has no underscore and is still reported.
function onError(err, req, res, _next) {
  const leftover = 1;
  res.status(500).send(err.message);
}

module.exports = { onError };
