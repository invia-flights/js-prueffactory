// Seam A tests of schema.drift with a real Docker daemon (Go:
// schema_drift_docker_test.go): the generator runs in a container on the
// Run's internal network, in a copy of the Working copy.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  benchmarkPart,
  findingsIn,
  type ParseExecution,
  type ParseReport,
  parseReport,
} from "./parse.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

/** driftExecution is the execution of schema.drift in the package at path. */
function driftExecution(s: ParseReport, path: string): ParseExecution {
  const c = s.contexts.find((x) => x.kind === "package" && x.path === path);
  const e = s.checks.find(
    (x) => x.check_id === "schema.drift" && x.context_id === c?.id,
  );
  assert.ok(e, `no execution of schema.drift in the package ${path}`);
  return e;
}

test("schema drift reports a stale file, leaves formatting alone, and a failing generator is partial", async (t) => {
  const original = copyProject(t, "schema-drift");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "schema.drift"]);

  // Drift is no Gate, but the failed generator makes the Run incomplete.
  const s = parseReport(r);
  assert.deepEqual([r.code, s.summary.gates], [2, 0], r.stderr);
  const root = driftExecution(s, ".");
  assert.deepEqual(
    [root.status, root.gate, root.outcome],
    ["completed", 0, "observations_only"],
  );

  // user.json differs in meaning: a warning with a diff artifact.
  const mine = findingsIn(s, "schema.drift").filter(
    (f) => f.context_id === root.context_id,
  );
  const changed = mine.filter((f) => f.rule_id === "schema-drift.changed");
  const created = mine.filter((f) => f.rule_id === "schema-drift.created");
  // Only schemas/user.json: order.json differs in formatting alone.
  assert.deepEqual(
    changed.map((f) => f.locations[0]?.path),
    ["schemas/user.json"],
  );
  const f = changed[0];
  assert.ok(f);
  assert.deepEqual(
    [f.severity, f.confidence, f.gate],
    ["warning", "confirmed", false],
  );
  assert.equal(f.evidence.length, 1);
  const artifactID = f.evidence[0]?.artifact_id;
  assert.ok(artifactID, "the diff is linked to an artifact");
  const diffPath = s.artifacts.find((a) => a.id === artifactID)?.path ?? "";
  assert.ok(
    diffPath.startsWith(`artifacts/schema.drift/${root.context_id}/`) &&
      diffPath.endsWith("-user.json.diff"),
    diffPath,
  );
  const diff = readFileSync(join(r.reportDir, diffPath), "utf8");
  for (const want of [
    "--- a/schemas/user.json",
    "+++ b/schemas/user.json",
    '+    "email"',
  ]) {
    assert.ok(diff.includes(want), `diff lacks ${want}:\n${diff}`);
  }
  assert.ok(
    !diff.includes("order.json"),
    "the formatting-only file is in the diff",
  );
  // The generator also writes a file the project does not commit.
  assert.deepEqual(
    created.map((x) => [x.severity, x.evidence[0]?.text]),
    [["note", "schemas/index.json"]],
  );

  // The nested package's generator needs the network and fails.
  const legacy = driftExecution(s, "tools/legacy");
  assert.deepEqual(
    [legacy.status, legacy.reason_code],
    ["partial", "generator_failed"],
  );
  const failed = findingsIn(s, "schema.drift").filter(
    (x) => x.context_id === legacy.context_id,
  );
  assert.deepEqual(
    failed.map((x) => [x.rule_id, x.severity, x.locations[0]?.path]),
    [["schema-drift.generator-failed", "warning", "tools/legacy/package.json"]],
  );
  const ev = failed[0]?.evidence[0];
  assert.equal(ev?.trust, "untrusted_data");
  assert.ok(ev.text.includes("cannot download the legacy schema"), ev.text);

  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("the schema drift part counts the drifted files and a failing generator makes it unknown", async (t) => {
  // Without the nested package, only the stale file is left.
  const original = copyProject(t, "schema-drift");
  rmSync(join(original, "tools"), { recursive: true });

  const r = await realRun(t, ["benchmark", original, "--only", "schema.drift"]);

  const part = benchmarkPart(parseReport(r), "schema_drift");
  assert.deepEqual([part.state, part.raw_value], ["measured", 1], r.stderr);
  assertNothingLeft(r);

  const withLegacy = await realRun(t, [
    "benchmark",
    copyProject(t, "schema-drift"),
    "--only",
    "schema.drift",
  ]);
  const p = benchmarkPart(parseReport(withLegacy), "schema_drift");
  assert.deepEqual(
    [p.state, p.reason],
    ["unknown", "partial: generator_failed"],
  );
  assertNothingLeft(withLegacy);
});
