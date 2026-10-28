'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');

describe('git', () => {
  it('passes without any program', () => {
    assert.strictEqual(1 + 1, 2);
  });

  it('answers --version', (done) => {
    // The plain Alpine Node image has no git, so this fails with
    // "spawn git ENOENT".
    const child = spawn('git', ['--version']);
    // A failed spawn emits "error" and then "close", so finish only once.
    let finished = false;
    const finish = (err) => {
      if (!finished) {
        finished = true;
        done(err);
      }
    };
    child.on('error', finish);
    child.on('close', (code) => {
      finish(code === 0 ? undefined : new Error('git exited with ' + code));
    });
  });
});
