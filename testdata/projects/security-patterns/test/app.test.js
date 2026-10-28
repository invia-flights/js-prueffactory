'use strict';

// Test code: the same patterns as in src/app.js live here and are not reported.
const { execSync } = require('child_process');

describe('app', () => {
  it('runs a command taken from the environment', () => {
    execSync('echo ' + process.env.GREETING);
  });
});
