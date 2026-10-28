'use strict';

const assert = require('node:assert');
const { add } = require('./index');

// Made-up credential for tests. It opens nothing.
const githubToken = "ghp_Tq7mZx2LwK9vRb4NcY8sFd3JhP5aEuG6oXiB";

describe('add', () => {
  it('adds two numbers', () => {
    assert.strictEqual(add(2, 3), 5);
    assert.ok(githubToken);
  });
});
