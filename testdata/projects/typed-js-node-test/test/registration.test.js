'use strict';

// The runner collects the calls that register tests, hooks and suites itself;
// awaiting them at the top level is not what its API wants.
const assert = require('node:assert');
const { test, describe, it, before, after, beforeEach, afterEach } = require('node:test');

before(async () => {});
after(async () => {});

test('adds numbers', async () => {
  assert.strictEqual(1 + 1, 2);
});
test.skip('is skipped', async () => {});
test.todo('comes later', async () => {});

describe('group', () => {
  beforeEach(async () => {});
  afterEach(async () => {});
  it('works', async () => {
    assert.ok(true);
  });
  it.only('is the focus', async () => {});
  describe.skip('is left out', () => {});
});

// This one is a real mistake: nobody waits for the rejection check.
test('forgets to wait', async () => {
  assert.rejects(Promise.reject(new Error('late')));
});
