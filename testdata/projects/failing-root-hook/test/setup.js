'use strict';

// A root-level hook: it runs before every suite, and here it fails.
before(() => {
  throw new Error('the test database is not reachable');
});
