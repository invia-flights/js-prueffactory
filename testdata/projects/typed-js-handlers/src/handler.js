'use strict';

// Promise chains for lint.typed. The handlers here are parameters of untyped
// functions (type any) or typed as Function, so that no call signature is known.

/** @returns {Promise<number>} */
async function load() {
  return 1;
}

/**
 * Handled: the chain ends in .catch(next), with next of type any.
 * @param {any} req
 * @param {any} res
 * @param {any} next
 */
function middleware(req, res, next) {
  Promise.all([load(), load()])
    .then(([a, b]) => {
      res.total = a + b;
      next();
    })
    .catch(next);
}

/**
 * Handled: a rejection handler as the second argument of then, and a
 * handler typed Function followed by finally.
 * @param {Function} onError
 */
function handled(onError) {
  load().then((a) => a + 1, onError);
  load().catch(onError).finally(() => 0);
}

/** No handler at all. */
function dropped() {
  load();
}

/** then with only a fulfilment handler leaves a rejection unhandled. */
function onlyFulfilled() {
  load().then((a) => a + 1);
}

module.exports = { middleware, handled, dropped, onlyFulfilled };
