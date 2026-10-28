'use strict';

// The spec pattern and the setup file are built in code, so no static reading
// of this file can find them.
const folders = ['src'];

module.exports = {
  spec: folders.map((folder) => `${folder}/**/*.spec.js`),
  require: [['.', 'src', 'setup.js'].join('/')],
};
