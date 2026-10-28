'use strict';

// Mocha resolves `require` relative to the working folder, which is the package root.
function createMochaConfig(layer, setupFiles) {
  return {
    spec: [`test/${layer}/**/*.test.js`],
    require: ['base.js', ...setupFiles].map((file) => `test/setup/${file}`),
    reporter: 'mocha-multi-reporters',
    reporterOptions: { reporterEnabled: 'spec' },
  };
}

module.exports = { createMochaConfig };
