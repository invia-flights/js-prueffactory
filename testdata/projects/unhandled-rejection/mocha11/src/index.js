'use strict';

// Resolves with the user's name after the service answered. The service is
// always down in this made-up project.
function loadUser() {
  return new Promise((resolve, reject) => {
    setImmediate(() => reject(new Error('user service is down')));
  });
}

function add(a, b) {
  return a + b;
}

module.exports = { loadUser, add };
