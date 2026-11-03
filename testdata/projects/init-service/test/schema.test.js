'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../lib/postgres.js');

// The test environment names the database, as the project's own tests do with
// their env file.
const env = fs.readFileSync(path.join(__dirname, '.test.env'), 'utf8');
process.env.DATABASE_URL = /^DATABASE_URL=(.+)$/m.exec(env)[1];

describe('the migrated schema', function () {
  this.timeout(10000);

  it('has the table the migrate service creates', async () => {
    assert.deepStrictEqual(await query('SELECT version FROM schema_migrations'), [['001_create_users']]);
  });
});
