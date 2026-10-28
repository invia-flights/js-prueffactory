'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { add } = require('../src/index');

// Every run of the suite loads this file once. The counter file lies in the
// package folder, which every run of the same Run shares, so the file counts
// the runs: 1 for the first run, 2 for the second and so on. It is never
// committed.
const counterFile = path.join(__dirname, '..', 'counter.txt');
const runNumber = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
fs.writeFileSync(counterFile, String(runNumber));

describe('counter', () => {
  it('passes in every run', () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it('fails only in the second run', () => {
    assert.notStrictEqual(runNumber, 2, 'this is run 2');
  });

  it('fails in every run', () => {
    assert.strictEqual(add(2, 2), 5);
  });
});
