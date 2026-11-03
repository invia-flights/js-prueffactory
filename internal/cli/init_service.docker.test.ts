// Seam A with a real Docker daemon: the compose file has a Postgres Service
// and an Init service, migrate, that the Run does not start. It creates the
// table the Mocha test reads, so the test fails for a reason of the Run's
// environment and not of the project. The Report says so instead of blaming
// the project: no Gate, a note that names the Init service, a Limitation with
// the reason code init_service_not_started, tests.existing partial, exit
// code 2, and in benchmark mode the Pass rate is unknown.
//
// The variants show what marks a Suite: a one-off service that depends on no
// Service the Run starts marks nothing, and of two packages only the one that
// names the prepared Service as a host is marked, unless none does.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  findingsOf,
  full,
  oneExecution,
  serviceNamed,
  writeFiles,
} from "./suites.testutil.ts";
import { benchmarkPartOf, whole } from "./whole.testutil.ts";

const existing = "tests.existing";
const initCode = "init_service_not_started";

// The migrate service of the project, without depends_on: a one-off helper
// that waits for nothing the Run starts.
const composeWithoutDependsOn = `services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust

  migrate:
    build: .
    command: npm run migrate
    environment:
      DATABASE_URL: postgres://postgres@postgres:5432/postgres
`;

// A second package that names nothing of the compose file and whose only test
// fails, so that a Gate shows up unless its Suite is marked.
const otherPackage = {
  "other/package.json": `{
  "name": "other",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" }
}
`,
  "other/test/broken.test.js": `'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

test('adds', () => {
  assert.strictEqual(1 + 1, 3);
});
`,
};

test("a test that needs what an Init service prepares is no Gate and the Pass rate is unknown", async (t) => {
  const original = copyProject(t, "init-service");

  const r = await realRun(t, ["benchmark", original, "--only", existing]);

  assert.equal(r.code, 2, `incomplete, no Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "partial");
  assert.equal(e.gate, 0);
  assert.equal(e.reason_code, initCode);
  assert.ok(e.reason?.includes("Init service migrate"), String(e.reason));

  // The test ran and failed because the migration did not run.
  assert.equal(s.summary.test_cases.failed, 1);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, "exactly the failed test");
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.gate, false);
  assert.equal(f.confidence, "suspected");
  assert.ok(
    f.message.includes(
      "the Service postgres, which the Init service migrate prepares, and the Run did not start migrate",
    ),
    f.message,
  );
  assert.deepEqual(f.limitations, [initCode]);
  const evidence = f.evidence.map((x) => x.text + "\n").join("");
  assert.ok(
    evidence.includes("schema_migrations"),
    `the Evidence does not show the missing table:\n${evidence}`,
  );

  // The Limitation names the Init service, its command and the Service it
  // prepares, and the file that refers to the Service.
  const marks = s.limitations.filter((l) => l.reason_code === initCode);
  assert.equal(marks.length, 1, JSON.stringify(s.limitations));
  const l = marks[0];
  assert.ok(l);
  assert.equal(l.check_id, existing);
  assert.equal(l.path, "docker-compose.yml");
  for (const want of [
    "Init service migrate",
    "`npm run migrate`",
    "postgres",
    "test/.test.env",
    "the service has a build section",
  ]) {
    assert.ok(l.message.includes(want), `${l.message} lacks ${want}`);
  }

  // The Services list shows the Init service as not started and what it does.
  assert.equal(serviceNamed(s, "postgres").status, "started");
  const migrate = serviceNamed(s, "migrate");
  assert.equal(migrate.status, "not_started");
  assert.ok(
    migrate.reason?.includes("Init service that prepares postgres"),
    String(migrate.reason),
  );
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes(
      "it is an Init service that prepares postgres (command npm run migrate)",
    ),
    "report.md lists the Init service with the Services",
  );
  assert.ok(md.includes(initCode), "report.md shows the Limitation");

  // Benchmark mode: the Pass rate is not measured, not zero.
  const b = whole(r).benchmark;
  const passRate = benchmarkPartOf(whole(r), "pass_rate");
  assert.equal(passRate.state, "unknown", JSON.stringify(passRate));
  assert.equal(passRate.score, null);
  assert.equal(b.verdict, "incomplete");
});

test("a one-off service that depends on no Service the Run starts marks nothing", async (t) => {
  const original = copyProject(t, "init-service");
  writeFiles(original, { "docker-compose.yml": composeWithoutDependsOn });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, `the failing test is a Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.gate, 1);
  const f = findingsOf(s, existing)[0];
  assert.ok(f);
  assert.equal(f.gate, true);
  assert.equal(f.confidence, "confirmed");
  assert.deepEqual(f.limitations, []);
  assert.deepEqual(
    s.limitations.filter((l) => l.reason_code === initCode),
    [],
  );
  assert.ok(
    !(serviceNamed(s, "migrate").reason ?? "").includes("Init service"),
    "the one-off service is no Init service",
  );
});

test("only the package that names the prepared Service as a host is marked", async (t) => {
  const original = copyProject(t, "init-service");
  writeFiles(original, otherPackage);

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(
    r.code,
    1,
    `the other package's failing test is a Gate\n${r.stderr}`,
  );
  assertNothingLeft(r);
  const s = full(r);
  const marked = s.limitations.filter((l) => l.reason_code === initCode);
  assert.equal(marked.length, 1, JSON.stringify(s.limitations));
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 2, JSON.stringify(fs.map((f) => f.title)));
  for (const f of fs) {
    const inOther = f.locations.some((x) => x.path.startsWith("other/"));
    assert.equal(
      f.gate,
      inOther,
      `${f.title}: Gate only in the unmarked package`,
    );
    assert.equal(f.confidence, inOther ? "confirmed" : "suspected", f.title);
  }
});

test("without a reference to the prepared Service every Suite of every package is marked", async (t) => {
  const original = copyProject(t, "init-service");
  writeFiles(original, otherPackage);
  // Nothing names postgres as a host any more: the test builds it in code.
  rmSync(join(original, "test", ".test.env"));
  writeFiles(original, {
    "test/schema.test.js": `'use strict';

const assert = require('node:assert');

// The host is put together here, so that no file names it as a URL host.
process.env.DATABASE_URL = ['postgres://postgres@post', 'gres:5432/postgres'].join('');
const { query } = require('../lib/postgres.js');

describe('the migrated schema', function () {
  this.timeout(10000);

  it('has the table the migrate service creates', async () => {
    assert.deepStrictEqual(await query('SELECT version FROM schema_migrations'), [['001_create_users']]);
  });
});
`,
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 2, `every failure is marked, no Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  const marked = s.limitations.filter((l) => l.reason_code === initCode);
  assert.equal(marked.length, 2, "a Limitation per package");
  for (const l of marked) {
    assert.ok(
      l.message.includes("No package of the project refers to postgres"),
      l.message,
    );
  }
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 2, JSON.stringify(fs.map((f) => f.title)));
  for (const f of fs) {
    assert.equal(f.gate, false, f.title);
    assert.equal(f.confidence, "suspected", f.title);
  }
});
