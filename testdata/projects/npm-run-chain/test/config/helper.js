'use strict';

const path = require('node:path');

// The configs of the layers share this helper, so that their paths are built
// in code and cannot be read from the config text.
const testRoot = path.join(__dirname, '..');

function layerConfig(layer) {
  return {
    spec: [`${layer}/**/*.test.js`].map((p) => path.join('test', p)),
    require: ['common', layer].map((name) => path.join(testRoot, 'setup', `${name}.js`)),
    exit: true,
    reporter: 'mocha-multi-reporters',
    reporterOptions: { reporterEnabled: 'spec' },
  };
}

module.exports = { layerConfig };
