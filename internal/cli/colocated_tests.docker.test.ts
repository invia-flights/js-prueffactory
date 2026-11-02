// Seam A with a real Docker daemon: Test code is what the project's test
// runner loads, wherever it lives. The specs sit next to the code and a Mocha
// config written in JavaScript selects them, so only the project's own Mocha
// can say which files are tests (Go: colocated_tests_docker_test.go).
//
// The probe runs inside package.install, so these tests select it. The Go
// tests also read lint.correctness, quality.suppressions and tests.coverage over
// the moved files; colocated_tests_lint, colocated_tests_inventory and
// colocated_tests_coverage have those parts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import { full, limitationOf, oneExecution } from "./suites.testutil.ts";

test("files the runner loads are Test code even next to the code, and a file with a test-like name is not", async (t) => {
  const original = copyProject(t, "colocated-tests");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,tests.existing",
  ]);

  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  const s = full(r);

  // The probe moved the spec and the file the config requires, and says which
  // suite loads them. src/ab-test.js is not among them.
  const moved: string[] = [];
  for (const m of s.inventory.moved_test_files) {
    assert.equal(m.suite, "scripts.test", "the suite is the test script");
    moved.push(`${m.path}:${m.kind}`);
  }
  assert.deepEqual(moved.sort(), [
    "src/a.spec.js:spec",
    "src/setup.js:require",
  ]);
  assert.ok(
    s.metrics.some(
      (m) =>
        m.check_id === "package.install" &&
        m.name === "test_files.moved:scripts.test" &&
        m.value === 2,
    ),
    JSON.stringify(s.metrics),
  );

  // The suite ran the spec, so the runner loaded nothing the probe missed.
  const e = oneExecution(s, "tests.existing");
  assert.equal(e.status, "completed");
  for (const l of s.limitations) {
    assert.ok(
      l.reason_code !== "test_files_not_resolved" &&
        l.reason_code !== "test_file_classified_as_source",
      `limitation ${JSON.stringify(l)}, want none`,
    );
  }
});

test("a Mocha config that throws leaves the static classes and says so", async (t) => {
  const original = copyProject(t, "colocated-tests-broken-config");

  const r = await realRun(t, ["test", original, "--only", "package.install"]);

  assertNothingLeft(r);
  const s = full(r);
  const l = limitationOf(s, "test_files_not_resolved");
  assert.ok(l, JSON.stringify(s.limitations));
  for (const want of ["scripts.test", "config boom"]) {
    assert.ok(
      l.message.includes(want),
      `the Limitation does not say ${want}: ${l.message}`,
    );
  }
  assert.deepEqual(s.inventory.moved_test_files, []);
});
