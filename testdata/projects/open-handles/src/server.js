'use strict';

const http = require('node:http');

// Starts a server on a free port and hands it back, so that the caller can
// close it again.
function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { start };
