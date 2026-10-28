'use strict';

// Loaded only by the setup file of the unit suite.
function unitMarker() {
  return 'unit';
}

function neverCalled() {
  return 'never';
}

module.exports = { unitMarker, neverCalled };
