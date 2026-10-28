// Runs as the postinstall script. It puts a package into node_modules that
// nothing requires, which `npm ls` reports as extraneous.
const fs = require('node:fs');

fs.mkdirSync('node_modules/stray', { recursive: true });
fs.writeFileSync('node_modules/stray/package.json', JSON.stringify({ name: 'stray', version: '1.0.0' }));
