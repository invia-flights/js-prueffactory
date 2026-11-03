import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  BenchmarkComputed,
  BenchmarkNotRequested,
  ReportShape,
  VerdictPass,
} from "../resultset/types.ts";
import { marshal } from "../gocompat/json.ts";
import { BenchmarkShape } from "../resultset/types.ts";
import { area, part, score, wantScore } from "./benchmark.testutil.ts";
import { compute } from "./score.ts";

// Go: TestACleanProjectScoresOneHundredAndPasses.
test("a clean project scores 100 and passes", () => {
  const s = score(scoredProject());
  const b = s.benchmark;

  assert.equal(b.status, BenchmarkComputed);
  assert.equal(b.profile_id, "benchmark-v2-uncalibrated");
  assert.equal(s.profiles.benchmark_profile, "benchmark-v2-uncalibrated");
  wantScore("score", b.score, 100);
  assert.deepEqual(b.range, { low: 100, high: 100 });
  assert.equal(b.verdict, VerdictPass);
  assert.deepEqual(b.gate_finding_ids, []);
});

// Go: TestComputeReadsTheSetAndChangesNothingInIt. The set is also frozen
// deeply, so a write anywhere below it would throw.
test("compute reads the set and changes nothing in it", () => {
  const p = scoredProject();
  p.add("lint.correctness", "no-undef", false);
  p.add("syntax.parse", "SyntaxError", true);
  const s = p.done();
  const before = marshal(s, ReportShape);
  deepFreeze(s);

  const first = compute(s);
  assert.equal(marshal(s, ReportShape), before, "compute changed the set");
  assert.equal(
    marshal(compute(s), BenchmarkShape),
    marshal(first, BenchmarkShape),
    "compute gives different sections for the same set",
  );
  assert.equal(
    s.benchmark.status,
    BenchmarkNotRequested,
    "only apply stores the section",
  );
});

function deepFreeze(v: unknown): void {
  if (typeof v !== "object" || v === null || Object.isFrozen(v)) {
    return;
  }
  Object.freeze(v);
  for (const child of Object.values(v)) {
    deepFreeze(child);
  }
}

// Go: TestTheFourAreasHaveTheSpecWeightsAndTheirContributionsAddUpToTheScore.
test("the four areas have the spec weights and their contributions add up to the score", () => {
  const b = score(scoredProject()).benchmark;
  const want: [string, number][] = [
    ["tests", 40],
    ["validity", 20],
    ["security", 25],
    ["code_correctness", 15],
  ];
  assert.equal(b.areas.length, want.length);
  want.forEach(([id, weight], i) => {
    const a = b.areas[i];
    assert.ok(a);
    assert.equal(a.id, id);
    assert.equal(a.weight, weight);
    assert.ok(a.exists && a.fully_measured, `area ${id}`);
    wantScore(`${id} score`, a.score, 100);
    wantScore(`${id} contribution`, a.contribution, weight);
  });
  wantScore("tests via area()", area(b, "tests").score, 100);
});

// Go: TestEveryPartShowsItsConstantsAndSourceChecks.
test("every part shows its constants and source Checks", () => {
  const b = score(scoredProject()).benchmark;
  const x50: Record<string, number> = {
    smells: 5,
    syntax: 1,
    structured_files: 1,
    openapi: 2,
    json_schema: 2,
    helm: 1,
    dependency_tree: 3,
    dockerfile_shell: 3,
    vulnerabilities: 10,
    lockfile_integrity: 5,
    correctness_lint: 10,
    project_linter: 5,
    node_compatibility: 3,
    suppressions: 20,
  };
  for (const [id, want] of Object.entries(x50)) {
    const p = part(b, id);
    assert.equal(p.x50, want, `part ${id} x50`);
    assert.notEqual(p.source_checks.length, 0, `part ${id} names no source`);
  }
  for (const id of ["pass_rate", "manifest", "install", "secrets"]) {
    assert.equal(part(b, id).x50, null, `part ${id} is not count-based`);
  }
  assert.deepEqual(part(b, "dockerfile_shell").source_checks, [
    "repository.dockerfile",
    "repository.shell",
  ]);
});
