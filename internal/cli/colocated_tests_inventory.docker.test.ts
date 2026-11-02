// Seam A with a real Docker daemon: the Inventory's Test code hashes over the
// files the runner loads (Go: colocated_tests_docker_test.go, the
// quality.suppressions part). colocated_tests.docker.test.ts has the probe's
// own part, colocated_tests_lint.docker.test.ts the lint part.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lintReport } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("the Inventory's Test code hashes have the files the runner loads, not the file with a test-like name", async (t) => {
  const original = copyProject(t, "colocated-tests");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,quality.suppressions",
  ]);

  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);

  // The Inventory's Test code hashes have the two moved files, not the other.
  const roles = new Map(s.inventory.file_hashes.map((h) => [h.path, h.role]));
  assert.equal(roles.get("src/a.spec.js"), "test_code");
  assert.equal(roles.get("src/setup.js"), "test_code");
  assert.ok(
    !roles.has("src/ab-test.js"),
    `src/ab-test.js is Source code and has no Test code hash: ${JSON.stringify([...roles])}`,
  );
});
