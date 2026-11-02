// Seam A tests of runtime.warnings: a project goes in through the entry
// point, the Report comes out (Go: runtime_warnings_docker_test.go). The suite
// runs once for tests.existing and runtime.warnings together.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { tarFiles } from "../docker/tar.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  findingsOf,
  full,
  type Full,
  type Limitation,
  oneExecution,
  serviceNamed,
  writeFiles,
} from "./suites.testutil.ts";

const warnings = "runtime.warnings";
const existing = "tests.existing";

function checkLimitation(
  s: Full,
  check: string,
  code: string,
): Limitation | undefined {
  return s.limitations.find(
    (l) => l.reason_code === code && l.check_id === check,
  );
}

test("a new Buffer in the source is a project warning from the same run as the tests", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, ["test", original, "--only", warnings]);

  assert.equal(r.code, 0, `no Gates\n${r.stderr}`);
  const s = full(r);
  const e = oneExecution(s, warnings);
  assert.equal(e.selected, true);
  assert.equal(e.status, "completed");
  const fs = findingsOf(s, warnings);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.rule_id, "warning-from-project");
  assert.equal(f.gate, false);
  assert.ok(f.title.includes("DEP0005"), f.title);
  assert.ok(f.message.includes("Buffer()"), f.message);
  assert.equal(f.locations[0]?.path, "src/index.js");
  assert.equal(f.locations[0].start?.line, 6);
  // The tests ran inside runtime.warnings' own run: tests.existing is not
  // selected, so it does not appear with Findings, and the suite ran once.
  assert.equal(oneExecution(s, existing).selected, false);
  const l = checkLimitation(s, warnings, "test_command_override");
  assert.ok(
    l?.message.includes("--trace-deprecation"),
    `the NODE_OPTIONS override is listed: ${JSON.stringify(s.limitations)}`,
  );
  assertNothingLeft(r);
});

test("with both Checks selected the suite runs once and each reports its own", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${warnings}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, existing).status, "completed");
  assert.equal(oneExecution(s, warnings).status, "completed");
  assert.equal(findingsOf(s, existing).length, 0);
  assert.equal(findingsOf(s, warnings).length, 1);
  const logged =
    r.stderr.split("running tests.existing").length -
    1 +
    (r.stderr.split("running runtime.warnings").length - 1);
  assert.equal(logged, 2, "both executions are logged");
  // One container ran the tests: the suite's own artifact belongs to
  // tests.existing, and the passed test is counted once.
  assert.equal(s.summary.test_cases.passed, 1);
  assertNothingLeft(r);
});

test("a Mocha suite without exit that leaves a server open is stopped after the grace period", async (t) => {
  const original = copyProject(t, "open-handles");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${warnings}`,
  ]);

  assert.equal(r.code, 0, `the hang is no Gate\n${r.stderr}`);
  const s = full(r);
  const tests = oneExecution(s, existing);
  assert.equal(tests.status, "completed");
  assert.equal(tests.outcome, "passed", "every result was recorded");
  assert.ok(
    tests.duration_ms !== null && tests.duration_ms >= 30_000,
    `the suite took ${String(tests.duration_ms)} ms, it should have waited the 30 second grace period`,
  );
  assert.ok(
    tests.tool?.exit_code !== null && tests.tool?.exit_code !== 0,
    `tool ${JSON.stringify(tests.tool)}: the exit code of a stopped container`,
  );
  assert.equal(oneExecution(s, warnings).status, "completed");
  const fs = findingsOf(s, warnings);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]?.rule_id, "process-did-not-exit");
  assert.equal(fs[0].title, "process did not exit after tests finished");
  assert.ok(fs[0].message.includes("TCPServerWrap"), fs[0].message);
  assert.equal(findingsOf(s, existing).length, 0);
  // The container's output has no trace of the marker.
  const log = artifactOf(s, tests, "test-output.log");
  assert.ok(log, "no test output artifact");
  const text = readFileSync(join(r.reportDir, log.path), "utf8");
  assert.ok(
    !text.includes("jspf-end"),
    `the end marker is in the test output:\n${text}`,
  );
  assertNothingLeft(r);
});

test("a hung suite without runtime.warnings selected is stopped and says so in a Limitation", async (t) => {
  const original = copyProject(t, "open-handles");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, existing).status, "completed");
  assert.ok(
    checkLimitation(s, existing, "process_stopped_after_grace"),
    JSON.stringify(s.limitations),
  );
  assert.equal(
    findingsOf(s, warnings).length,
    0,
    "runtime.warnings is not selected",
  );
  assertNothingLeft(r);
});

test("a server left open under Mocha's exit is one open-resources Finding and no stop", async (t) => {
  const original = copyProject(t, "open-handles");
  writeFiles(original, { ".mocharc.json": `{"exit": true}\n` });

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${warnings}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const tests = oneExecution(s, existing);
  assert.ok(
    tests.duration_ms === null || tests.duration_ms < 30_000,
    `the forced exit ended the process, but the suite took ${String(tests.duration_ms)} ms`,
  );
  const fs = findingsOf(s, warnings);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]?.rule_id, "open-resources");
  assert.ok(fs[0].message.includes("TCPServerWrap"), fs[0].message);
  assert.ok(
    !fs[0].message.includes("PipeWrap"),
    `${fs[0].message} lists the streams of stdout and stderr, which are not the project's`,
  );
  assertNothingLeft(r);
});

test("a clean suite has no runtime warnings", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${warnings}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    findingsOf(full(r), warnings),
    [],
    "a forced exit with nothing open leaves nothing to report",
  );
  assertNothingLeft(r);
});

test("a node:test suite reports warnings but not open resources and says so", async (t) => {
  const original = copyProject(t, "node-test");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${warnings}`,
  ]);

  // The project has one failing test, so tests.existing fires a Gate: that
  // does not keep runtime.warnings from reading the same run.
  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, warnings).status, "completed");
  assert.ok(
    checkLimitation(s, warnings, "open_resources_not_collected"),
    JSON.stringify(s.limitations),
  );
  assertNothingLeft(r);
});

/** dependencyTarball is an npm package that calls the deprecated new Buffer(). */
async function dependencyTarball(): Promise<Buffer> {
  const tar = await tarFiles([
    {
      path: "/package/package.json",
      content: Buffer.from(
        `{"name":"old-buffer","version":"1.0.0","main":"index.js"}`,
      ),
    },
    {
      path: "/package/index.js",
      content: Buffer.from(
        "'use strict';\nmodule.exports = (n) => new Buffer(n);\n",
      ),
    },
  ]);
  return gzipSync(tar);
}

test("a warning from code in node_modules is a dependency warning", async (t) => {
  const original = copyProject(t, "clean-mocha");
  // No lockfile, so the install resolves the tarball too.
  rmSync(join(original, "package-lock.json"), { force: true });
  writeFiles(original, {
    "package.json":
      `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"dependencies":{"old-buffer":"file:./old-buffer.tgz"},"devDependencies":{"mocha":"^10.8.2"}}` +
      "\n",
    "test/old.test.js":
      "'use strict';\n\nconst oldBuffer = require('old-buffer');\n\ndescribe('old', () => {\n  it('allocates', () => {\n    oldBuffer(4);\n  });\n});\n",
  });
  writeFileSync(join(original, "old-buffer.tgz"), await dependencyTarball());

  const r = await realRun(t, ["test", original, "--only", warnings]);

  assert.equal(r.code, 0, r.stderr);
  const fs = findingsOf(full(r), warnings);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]?.rule_id, "warning-from-dependency");
  assert.ok(fs[0].message.includes("old-buffer"), fs[0].message);
  assert.equal(fs[0].severity, "note");
  assert.equal(fs[0].gate, false);
  assertNothingLeft(r);
});

test("runtime.warnings alone starts the Services of the suite it runs", async (t) => {
  const original = copyProject(t, "valkey-service");

  const r = await realRun(t, ["test", original, "--only", warnings]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    serviceNamed(full(r), "redis").status,
    "started",
    "started for the suite that runtime.warnings runs",
  );
  assertNothingLeft(r);
});
