'use strict';

const { query } = require('../lib/postgres.js');

// The migration the compose service migrate runs before the tests: it creates
// the table the tests read.
query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY);
   INSERT INTO schema_migrations VALUES ('001_create_users') ON CONFLICT DO NOTHING`,
).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
