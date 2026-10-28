'use strict';

// Not loaded by the test runner: Source code, whatever its name says. The
// undefined variable is a real no-undef that must still be reported here.
function abTest() {
  return experimentGroup;
}

module.exports = { abTest };
