// Seam A with a real Docker daemon: the project's test environment names a
// compose Service the Run does not start (minio, an unknown family). Its
// integration suite fails because of that, quickly and with a lookup error,
// and the Report says so instead of blaming the project: no Gate, a note on
// the failure, a Limitation per suite in the Gaps, tests.existing partial (Go:
// missing_service_docker_test.go).
//
// The Go tests also select runtime.warnings and check its open-resources
// Findings for the same marks; that Check is ported by ticket 15, which
// extends these tests.
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

const existing = "tests.existing";

test("a suite that needs a Service the Run did not start is marked and not blamed on the project", async (t) => {
  const original = copyProject(t, "missing-service");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 2, `incomplete, no Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "partial");
  assert.equal(e.gate, 0);
  assert.equal(e.reason_code, "service_not_started");

  // The suites ran: the unit test passed, the integration test failed.
  assert.equal(s.summary.test_cases.passed, 1);
  assert.equal(s.summary.test_cases.failed, 1);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, "exactly the failed integration test");
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.gate, false);
  assert.equal(f.confidence, "suspected");
  assert.equal(f.suite, "test:integration");
  assert.ok(f.message.includes("minio"), f.message);
  assert.ok(f.message.includes("did not start"), f.message);
  const evidence = f.evidence.map((x) => x.text + "\n").join("");
  assert.ok(
    evidence.includes("EAI_AGAIN") || evidence.includes("ENOTFOUND"),
    `the Evidence shows no lookup error:\n${evidence}`,
  );

  // The failure came well before the test's own 5 s timeout, because the
  // Run's resolver options make a lookup of an unknown name fail within 1 s.
  for (const tc of s.test_cases) {
    if (tc.outcome !== "failed") continue;
    const last = tc.attempts.at(-1);
    assert.ok(
      last !== undefined && last.duration_ms < 3000,
      `failed test ${tc.full_title} = ${JSON.stringify(tc.attempts)}`,
    );
  }

  // Gaps: one service_not_started Limitation per suite of the package, naming
  // the Service, why it was not started and the file that refers to it. The
  // Services table still lists minio as not started.
  const suites: string[] = [];
  for (const l of s.limitations) {
    if (l.reason_code !== "service_not_started") continue;
    assert.equal(l.path, "test/.test.env", JSON.stringify(l));
    assert.ok(l.message.includes("minio"), l.message);
    assert.ok(l.message.includes("line 2"), l.message);
    assert.ok(
      l.message.includes("only official Docker Hub images") ||
        l.message.includes("no known test Service family"),
      l.message,
    );
    for (const name of ["test:integration", "test:unit"]) {
      if (l.message.includes("`" + name + "`")) suites.push(name);
    }
  }
  assert.equal(
    suites.join(","),
    "test:integration,test:unit",
    "a Limitation per suite",
  );
  assert.equal(serviceNamed(s, "minio").status, "not_started");
  assert.equal(serviceNamed(s, "redis").status, "started");

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes("service_not_started"),
    "report.md shows the Limitation",
  );
});

// A Suite is marked on its own when only a runtime mark exists. Here nothing
// refers to minio in a way the static search finds (the host is built in code),
// so only the integration Suite, whose lookup fails, is marked. The unit Suite
// leaves a server open too, and its Finding stays what it was without the
// Service note: confirmed, with no note and no Limitation reference
// (runtime.warnings, which makes that Finding, is ticket 15's).
test("an unmarked suite keeps its runtime marks apart while the marked suite gets the note", async (t) => {
  const original = copyProject(t, "missing-service");
  rmSync(join(original, "test", ".test.env"));
  writeFiles(original, {
    "test/integration/translations.test.js": `'use strict';

const http = require('node:http');
const net = require('node:net');

// The host is put together here, so that no file names it as a URL host.
const host = ['mini', 'o'].join('');

function keepConnected() {
  const socket = net.connect({ host, port: 9000 });
  socket.on('error', () => {});
  socket.on('close', keepConnected);
}

describe('translations', function () {
  this.timeout(5000);

  it('are read from the translation store', (done) => {
    keepConnected();
    http.get({ host, port: 9000, timeout: 5000 }, () => done()).on('error', done);
  });
});
`,
    "test/unit/server.test.js": `'use strict';

const assert = require('node:assert');
const net = require('node:net');

// A listening server that nothing closes, so that the run ends with it open.
describe('local server', () => {
  it('listens', (done) => {
    const server = net.createServer();
    server.listen(0, () => {
      assert.ok(server.address().port > 0);
      done();
    });
  });
});
`,
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assertNothingLeft(r);
  const s = full(r);
  const marked: string[] = [];
  for (const l of s.limitations) {
    if (l.reason_code !== "service_not_started") continue;
    for (const name of ["test:integration", "test:unit"]) {
      if (l.message.includes("`" + name + "`")) marked.push(name);
    }
  }
  assert.equal(
    marked.join(","),
    "test:integration",
    `service_not_started Limitations: ${JSON.stringify(s.limitations)}`,
  );
  const e = oneExecution(s, existing);
  assert.equal(e.status, "partial");
  assert.equal(e.reason_code, "service_not_started");
  assert.ok(e.reason?.includes("test:integration"), String(e.reason));
  assert.ok(!(e.reason ?? "").includes("test:unit"), e.reason ?? "");
});
