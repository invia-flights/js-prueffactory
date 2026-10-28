'use strict';

// The spec pattern is built in code, so no static reading of this file can
// find it: only the project's own Mocha says that src/a.spec.js is a test.
const folders = ['src'];

module.exports = {
  spec: folders.map((folder) => `${folder}/**/*.spec.js`),
};
