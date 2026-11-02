// Seam A with a real Docker daemon, for the rule groups of tests.smells and
// deps.engines in the combined ESLint run (Go: cli_eslint_groups_docker_test.go).
// The quality.metrics test of that file belongs to ticket 22. The Go tests ran
// the default Selection; these select the Check they read.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { findingsOf, lintReport, packageExecution } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("a committed .only is a Gate and a pending test is a warning", async (t) => {
  const original = copyProject(t, "committed-only");
  // node:test files are covered, because test is a test-case name and their
  // imports are followed.
  writeFileSync(
    join(original, "test", "node.test.mjs"),
    "import { test } from 'node:test';\n\ntest.only('focused', () => {});\n",
  );

  const r = await realRun(t, ["test", original, "--only", "tests.smells"]);

  assert.equal(r.code, 1, `a committed .only is a Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = packageExecution(r, s, "tests.smells");
  assert.equal(exec.status, "completed");
  assert.equal(exec.outcome, "failed", String(exec.reason));

  const got: Record<string, string> = {};
  for (const f of findingsOf(s, "tests.smells")) {
    got[`${String(f.rule_id)}@${f.locations[0]?.path ?? ""}`] = f.gate
      ? "gate"
      : "warning";
  }
  assert.deepEqual(got, {
    "mocha/no-exclusive-tests@test/add.test.js": "gate",
    "mocha/no-exclusive-tests@test/node.test.mjs": "gate",
    "mocha/no-pending-tests@test/add.test.js": "warning",
  });
});

test("new Buffer is a warning of deps.engines on the package's Node version", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, ["test", original, "--only", "deps.engines"]);

  assert.equal(r.code, 0, `deps.engines findings are warnings\n${r.stderr}`);
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = packageExecution(r, s, "deps.engines");
  assert.equal(exec.status, "completed", String(exec.reason));
  const found = findingsOf(s, "deps.engines");
  assert.equal(found.length, 1, "the one new Buffer()");
  const f = found[0];
  assert.ok(f);
  assert.equal(f.rule_id, "n/no-deprecated-api");
  assert.ok(!f.gate && f.severity === "warning");
  assert.equal(f.locations[0]?.path, "src/index.js");
  assert.equal(f.locations[0].start?.line, 6);
  assert.ok(f.message.includes("new Buffer()"), f.message);
});

test("only the rule groups of selected Checks are switched on", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, ["test", original, "--only", "deps.engines"]);

  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);
  assert.equal(findingsOf(s, "deps.engines").length, 1);
  for (const f of s.findings) {
    assert.equal(f.check_id, "deps.engines", "only deps.engines is selected");
  }
  // The config's hash covers the groups that were on.
  for (const c of s.contexts) {
    for (const tool of c.tools) {
      if (tool.name === "eslint-config") {
        assert.notEqual(tool.digest, null);
      }
    }
  }
});
