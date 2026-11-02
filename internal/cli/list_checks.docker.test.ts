// The Selection is recorded in the Report, and the Checks it leaves out show
// up as deselected without changing the exit code (Go:
// list_checks_docker_test.go). The assertions follow from the implemented
// Catalog, so they hold while more Checks get implemented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import "../checks/all.ts";
import { implementedIDs } from "../checks/catalog.ts";
import { parseReport } from "./parse.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("--only records the Selection and reports deselected Checks", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", "syntax.parse"]);

  assert.equal(r.code, 0, r.stderr);
  const s = parseReport(r);
  const sel = s.selection;
  assert.deepEqual(sel.only, ["syntax.parse"]);
  assert.deepEqual(sel.exclude, []);
  assert.deepEqual(sel.effective_checks, ["syntax.parse"]);
  const others = implementedIDs().filter((id) => id !== "syntax.parse");
  assert.deepEqual(sel.deselected_checks, others);
  assert.equal(sel.is_standard_scope, others.length === 0);

  const deselected = new Set<string>();
  for (const e of s.checks) {
    if (e.selected) {
      assert.deepEqual([e.check_id, e.status], ["syntax.parse", "completed"]);
      continue;
    }
    deselected.add(e.check_id);
    assert.deepEqual([e.status, e.reason_code], ["not_started", "deselected"]);
  }
  for (const id of others) {
    assert.ok(deselected.has(id), `${id} is not in the Report as deselected`);
  }

  const scope = s.summary.scope_completeness;
  const std = s.summary.standard_completeness;
  assert.deepEqual([scope.required, scope.completed], [1, 1]);
  if (others.length === 0) {
    assert.deepEqual(std, scope);
  } else {
    assert.equal(std.completed, 1);
  }

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(md.includes("Scope completeness: 1 of 1"), md);
  if (others.length > 0) {
    assert.ok(
      md.includes("deselected"),
      "report.md lists the deselected Checks",
    );
  }
  assertNothingLeft(r);
});

test("a full Run records the standard scope", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original]);

  const s = parseReport(r);
  const sel = s.selection;
  assert.equal(sel.is_standard_scope, true);
  assert.deepEqual(
    [sel.deselected_checks, sel.only, sel.exclude],
    [[], [], []],
  );
  assert.deepEqual(sel.effective_checks, implementedIDs());
  assert.deepEqual(
    s.summary.standard_completeness,
    s.summary.scope_completeness,
  );
  assertNothingLeft(r);
});
