// The default Budget of a --fast Run (Go: budget_docker_test.go). The tiny
// Budget test lives in cancel.docker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SchemaVersion } from "../resultset/types.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import { whole } from "./whole.testutil.ts";

test("a --fast Run of clean-mocha records fast and the fast default Budget", async (t) => {
  // Go: TestFastRunOfCleanMochaRecordsFastAndTheFastDefaultBudget
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--fast"]);

  assert.equal(r.code, 0, r.stderr);
  const s = whole(r);
  assert.deepEqual(
    [s.run.budget_seconds, s.run.budget_source],
    [1800, "fast_default"],
  );
  assert.equal(
    s.selection.fast,
    true,
    "selection.fast is false for a --fast Run",
  );
  assert.deepEqual(
    [
      s.schema_version,
      s.profiles.catalog_version,
      s.profiles.execution_profile,
    ],
    [SchemaVersion, "milestone-2", "execution-v2"],
  );
  // Every Check marked for --fast is still planned, so nothing is left out.
  assert.deepEqual(s.selection.deselected_checks, []);
  assertNothingLeft(r);

  const plain = await realRun(t, ["test", copyProject(t, "clean-mocha")]);
  const p = whole(plain);
  assert.deepEqual(
    [p.run.budget_seconds, p.run.budget_source, p.selection.fast],
    [7200, "default", false],
    "a plain Run",
  );
  assertNothingLeft(plain);
});
