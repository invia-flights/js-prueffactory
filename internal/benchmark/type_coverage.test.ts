import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartNotApplicable,
  PartUnknown,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newContext, newMetric } from "../resultset/zero.ts";
import {
  area,
  fingerprintOf,
  indicator,
  part,
  score,
  wantScore,
} from "./benchmark.testutil.ts";

// Type coverage is the one part that scores a percentage as it is, and the
// strict-gap error count is a side indicator. Expected values are worked out
// by hand.

/**
 * withTypeStrictness adds types.strictness to the clean project with its
 * metrics for the package Context.
 */
function withTypeStrictness(
  percent: number,
  identifiers: number,
  gap: number,
): Project {
  const p = scoredProject();
  p.addExecution("types.strictness", "C-0002");
  p.metric("types.strictness", "type_coverage_percent", percent, "percent");
  p.metric(
    "types.strictness",
    "type_coverage_identifiers",
    identifiers,
    "identifiers",
  );
  p.metric("types.strictness", "strict_gap_errors", gap, "errors");
  return p;
}

// Go: TestTypeCoverageScoresItsPercentageDirectlyInCodeCorrectness.
test("type coverage scores its percentage directly in Code correctness", () => {
  const b = score(withTypeStrictness(82.5, 200, 0)).benchmark;

  const got = part(b, "type_coverage");
  assert.equal(got.state, PartMeasured);
  assert.equal(got.x50, null);
  assert.equal(got.raw_unit, "percent");
  wantScore("type coverage raw value", got.raw_value, 82.5);
  wantScore("type coverage score", got.score, 82.5);
  assert.deepEqual(got.source_checks, ["types.strictness"]);
  // The area is the minimum of its parts, and the other Code correctness
  // parts are clean.
  wantScore("code correctness score", area(b, "code_correctness").score, 82.5);
});

// Go: TestTypeCoverageOfSeveralPackagesWeighsEachByItsIdentifiers.
test("type coverage of several packages weighs each by its identifiers", () => {
  const p = withTypeStrictness(100, 10, 0);
  // A second package: 30 identifiers at 50 percent. 10 + 15 typed of 40 is 62.5.
  p.set.contexts.push(
    newContext({ id: "C-0003", kind: "package", path: "packages/b" }),
  );
  const e = p.set.checks.at(-1);
  assert.ok(e);
  p.set.checks.push({ ...e, id: "added-second", context_id: "C-0003" });
  for (const [name, value, unit] of [
    ["type_coverage_percent", 50, "percent"],
    ["type_coverage_identifiers", 30, "identifiers"],
  ] as const) {
    p.set.metrics.push(
      newMetric({
        id: `tmp-${name}-b`,
        check_id: "types.strictness",
        context_id: "C-0003",
        name,
        value,
        unit,
      }),
    );
  }

  wantScore(
    "type coverage",
    part(score(p).benchmark, "type_coverage").score,
    62.5,
  );
});

// Go: TestTypeCoverageIsUnknownWhenTheCheckDidNotComplete.
test("type coverage is unknown when the Check did not complete", () => {
  const p = withTypeStrictness(90, 100, 0);
  p.status("types.strictness", StatusUnsupported, "build_step_required");

  const got = part(score(p).benchmark, "type_coverage");

  assert.equal(got.state, PartUnknown);
  assert.equal(got.score, null);
});

// Go: TestTypeCoverageIsNotApplicableWithoutAPackageToExamine.
test("type coverage is not applicable without a package to examine", () => {
  const p = withTypeStrictness(90, 100, 0);
  p.notApplicable("types.strictness");

  assert.equal(
    part(score(p).benchmark, "type_coverage").state,
    PartNotApplicable,
  );
});

// Go: TestTheStrictGapIsASideIndicatorThatNeverChangesTheScore.
test("the strict gap is a side indicator that never changes the score", () => {
  const quiet = score(withTypeStrictness(80, 100, 0)).benchmark;
  const noisy = score(withTypeStrictness(80, 100, 1234)).benchmark;

  const got = indicator(noisy, "strict_gap_errors");
  wantScore("strict gap errors", got.value, 1234);
  assert.equal(got.state, PartMeasured);
  assert.equal(got.unit, "errors");
  assert.equal(noisy.score, quiet.score);
  assert.deepEqual(noisy.range, quiet.range);
  assert.equal(noisy.verdict, quiet.verdict);
});

// Go: TestTheStrictGapIsUnknownUntilTheCheckTakesPart.
test("the strict gap is unknown until the Check takes part", () => {
  const got = indicator(score(scoredProject()).benchmark, "strict_gap_errors");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.value, null);
});

// Go: TestTheTypeScript6VersionIsPartOfTheFingerprint.
test("the TypeScript 6 version is part of the fingerprint", () => {
  const tsVersion = (v: string) => {
    const p = scoredProject();
    p.set.contexts[1]?.tools.push({
      name: "typescript6",
      version: v,
      digest: null,
    });
    return p;
  };
  const base = fingerprintOf(tsVersion("6.0.2"));

  assert.equal(base.fields.typescript6_version, "6.0.2");
  assert.notEqual(fingerprintOf(tsVersion("6.0.3")).hash, base.hash);
  const none = fingerprintOf(scoredProject());
  assert.equal(none.fields.typescript6_version, null);
  assert.notEqual(none.hash, base.hash);
});
