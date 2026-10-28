'use strict';

// Writes one JSON Schema per component of api/openapi.json into schemas/, plus
// an index of the names.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = JSON.parse(fs.readFileSync(path.join(root, 'api', 'openapi.json'), 'utf8'));
const names = Object.keys(api.components.schemas).sort();

for (const name of names) {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', title: name, ...api.components.schemas[name] };
  fs.writeFileSync(path.join(root, 'schemas', `${name.toLowerCase()}.json`), JSON.stringify(schema, null, 2) + '\n');
}
fs.writeFileSync(path.join(root, 'schemas', 'index.json'), JSON.stringify({ schemas: names }) + '\n');
