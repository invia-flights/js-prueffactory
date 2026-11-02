// Seam A with a real Docker daemon, for types.strictness (Go:
// types_strictness_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactOf,
  findingsOf,
  type LintReport,
  lintReport,
  oneExecution,
  partOf,
} from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

function metricNamed(s: LintReport, check: string, name: string) {
  return s.metrics.find((m) => m.check_id === check && m.name === name);
}

test("types.strictness measures type coverage and reports the strict-only error as a note", async (t) => {
  const original = copyProject(t, "typed-js");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "types.strictness"]);

  assert.equal(
    r.code,
    0,
    `strict-gap errors are notes and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");

  const s = lintReport(r);
  const exec = oneExecution(s, "types.strictness");
  assert.equal(exec.status, "completed", r.stderr);
  assert.equal(exec.tool?.name, "tsc6");
  assert.equal(exec.tool.version, "6.0.2", "TypeScript 6 at the pinned 6.0.2");
  const command = exec.command.join(" ");
  assert.ok(command.includes("typescript6/bin/tsc6"), command);
  assert.ok(command.includes("-p /jspf/tsconfig.strict.json"), command);
  assert.ok(
    s.selection.prerequisites_run.includes("package.install"),
    JSON.stringify(s.selection),
  );

  // The typed functions are covered and the untyped one is not.
  const pct = metricNamed(s, "types.strictness", "type_coverage_percent");
  assert.ok(
    pct?.value !== undefined &&
      pct.value !== null &&
      pct.value > 0 &&
      pct.value < 100,
    `type_coverage_percent ${JSON.stringify(pct)}, want strictly between 0 and 100`,
  );
  const ids = metricNamed(s, "types.strictness", "type_coverage_identifiers");
  assert.ok(ids?.value !== null && (ids?.value ?? 0) > 0, JSON.stringify(ids));
  const tc = metricNamed(
    s,
    "types.strictness",
    "type_coverage_test_code_percent",
  );
  assert.ok(
    tc !== undefined && tc.value !== null,
    `type_coverage_test_code_percent ${JSON.stringify(tc)}, want a value: Test code is measured on its own`,
  );
  assert.equal(
    metricNamed(s, "types.strictness", "strict_gap_errors")?.value,
    1,
    "strict_gap_errors",
  );

  const got = findingsOf(s, "types.strictness");
  assert.equal(
    got.length,
    1,
    `findings ${JSON.stringify(got)}, want the one error that only strict mode reports`,
  );
  const f = got[0];
  assert.ok(f);
  assert.equal(f.rule_id, "TS7006");
  assert.ok(
    !f.gate && f.severity === "note" && f.confidence === "suspected",
    JSON.stringify(f),
  );
  assert.equal(f.locations[0]?.path, "src/untyped.js");
  assert.equal(f.locations[0].start?.line, 5);
  assert.ok(
    artifactOf(s, exec, "C-0002-tsconfig-strict.json"),
    `no strict tsconfig artifact: ${JSON.stringify(s.artifacts)}`,
  );
});

test("the Benchmark scores type coverage as its percentage and shows the strict gap as a side indicator", async (t) => {
  const original = copyProject(t, "typed-js");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "types.strictness",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = lintReport(r);
  const pct = metricNamed(s, "types.strictness", "type_coverage_percent");
  const part = partOf(s, "type_coverage");
  assert.ok(
    pct?.value !== null && part.state === "measured" && part.score !== null,
    `metric ${JSON.stringify(pct)}, part ${JSON.stringify(part)}`,
  );
  assert.equal(
    part.score,
    Math.floor((pct?.value ?? 0) * 10 + 0.5) / 10,
    "the percentage as it is",
  );
  const side = s.benchmark.side_indicators.find(
    (x) => x.id === "strict_gap_errors",
  );
  assert.ok(side, "no strict_gap_errors side indicator");
  assert.ok(
    side.state === "measured" && side.value === 1,
    `strict_gap_errors ${JSON.stringify(side)}, want measured with 1`,
  );
  assert.equal(
    s.benchmark.fingerprint?.fields.typescript6_version,
    "6.0.2",
    "the TypeScript 6 version",
  );
  assertNothingLeft(r);
});
