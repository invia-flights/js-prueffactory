'use strict';

// A generator that only the npm script `generate` runs, on a developer's
// machine, where devDependencies are installed.
const Mocha = require('mocha');
const { start } = require('../src/app');

process.stdout.write(JSON.stringify({ mocha: typeof Mocha, app: start() }) + '\n');
