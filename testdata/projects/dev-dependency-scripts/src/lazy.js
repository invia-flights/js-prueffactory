'use strict';

// The devDependency is loaded only when the function runs, which still
// happens in production.
function reporterName() {
  const Mocha = require('mocha');
  return Mocha.reporters.Spec.name;
}

module.exports = { reporterName };
