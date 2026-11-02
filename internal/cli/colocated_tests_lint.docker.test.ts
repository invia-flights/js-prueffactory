// Seam A with a real Docker daemon: Test code is what the project's test
// runner loads, wherever it lives, and lint.correctness reads those classes
// (Go: colocated_tests_docker_test.go). colocated_tests.docker.test.ts has the
// probe's own part, colocated_tests_inventory.docker.test.ts the Inventory's
// Test code file hashes of the moved files and colocated_tests_coverage.docker.test.ts
// the coverage part.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lintReport, type LintReport } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

function noUndefIn(s: LintReport, check: string): string[] {
  const paths = s.findings
    .filter((f) => f.check_id === check && f.rule_id === "no-undef")
    .map((f) => f.locations[0]?.path ?? "");
  return [...new Set(paths)].sort();
}

test("Mocha globals are known in a spec the runner loads next to the code and a file with a test-like name is still Source code", async (t) => {
  const original = copyProject(t, "colocated-tests");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,lint.correctness",
  ]);

  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);

  // The probe moved the spec and the file the config requires. src/ab-test.js
  // is not among them.
  assert.deepEqual(
    s.inventory.moved_test_files.map((m) => `${m.path}:${m.kind}`).sort(),
    ["src/a.spec.js:spec", "src/setup.js:require"],
  );

  // No Mocha global is undefined in the spec, and a real no-undef in the file
  // the runner does not load is still reported: it is Source code.
  assert.deepEqual(
    noUndefIn(s, "lint.correctness"),
    ["src/ab-test.js"],
    "no-undef in src/ab-test.js only",
  );

  // The probe resolved everything, and the runner loaded nothing else.
  for (const l of s.limitations) {
    assert.ok(
      l.reason_code !== "test_files_not_resolved" &&
        l.reason_code !== "test_file_classified_as_source",
      `limitation ${JSON.stringify(l)}, want none`,
    );
  }
});

test("a Mocha config that throws leaves the static classes, so the spec in src is Source code to lint.correctness", async (t) => {
  const original = copyProject(t, "colocated-tests-broken-config");

  const r = await realRun(t, ["test", original, "--only", "lint.correctness"]);

  assertNothingLeft(r);
  const s = lintReport(r);
  const l = s.limitations.find(
    (x) => x.reason_code === "test_files_not_resolved",
  );
  assert.ok(l, JSON.stringify(s.limitations));
  for (const want of ["scripts.test", "config boom"]) {
    assert.ok(
      l.message.includes(want),
      `the Limitation does not say ${want}: ${l.message}`,
    );
  }
  assert.deepEqual(s.inventory.moved_test_files, []);
  // The spec is in src/, so by its place it is Source code and `describe` is
  // not known there.
  assert.deepEqual(
    noUndefIn(s, "lint.correctness"),
    ["src/a.spec.js"],
    "the static classes stay",
  );
});
