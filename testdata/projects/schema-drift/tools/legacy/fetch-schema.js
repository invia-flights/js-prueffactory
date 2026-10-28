'use strict';

// Downloads the legacy schema from a host the project controls. It needs
// network, so it fails when the Run has none.
const https = require('node:https');

https
  .get('https://schemas.example.com/legacy.json', (res) => {
    console.log(`status ${res.statusCode}`);
  })
  .on('error', (err) => {
    console.error(`cannot download the legacy schema: ${err.code}`);
    process.exit(1);
  });
