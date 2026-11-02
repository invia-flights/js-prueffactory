import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusPartial,
} from "../resultset/types.ts";
import { area, part, score, wantScore } from "./benchmark.testutil.ts";

// The Unhandled rejections part of the Code correctness area counts the
// Findings of runtime.unhandled-rejections, x50 = 2. Expected scores are
// worked out by hand from S = 100 * 2^(-x / x50).

// Go: TestTwoUnhandledRejectionFindingsHalveThePartAndTheCodeCorrectnessArea.
test("two unhandled rejection Findings halve the part and the Code correctness area", () => {
  const p = scoredProject();
  p.add("runtime.unhandled-rejections", "unhandled-rejection", false);
  p.add("runtime.unhandled-rejections", "unhandled-rejection", false);
  const got = part(score(p).benchmark, "unhandled_rejections");

  assert.equal(got.state, PartMeasured);
  wantScore("raw value", got.raw_value, 2);
  wantScore("part score", got.score, 50);
  assert.equal(got.n_eff, null, "the part counts Findings and does not damp");
  assert.equal(got.x50, 2);
});

// Go: TestACrashFindingCountsLikeATestFindingAndNoFindingScoresAHundred.
test("a crash Finding counts like a test Finding and no Finding scores 100", () => {
  wantScore(
    "no Finding",
    part(score(scoredProject()).benchmark, "unhandled_rejections").score,
    100,
  );

  const p = scoredProject();
  p.add("runtime.unhandled-rejections", "unhandled-rejection-crash", false);
  for (let i = 0; i < 3; i++) {
    p.add("runtime.unhandled-rejections", "unhandled-rejection", false);
  }
  const got = part(score(p).benchmark, "unhandled_rejections");
  wantScore("raw value", got.raw_value, 4);
  wantScore("four Findings: 100 * 2^-2", got.score, 25);
});

// Go: TestTheUnhandledRejectionsPartBelongsToTheCodeCorrectnessArea.
test("the Unhandled rejections part belongs to the Code correctness area", () => {
  const p = scoredProject();
  p.add("runtime.unhandled-rejections", "unhandled-rejection", false);
  p.add("runtime.unhandled-rejections", "unhandled-rejection", false);
  const a = area(score(p).benchmark, "code_correctness");

  assert.ok(a.parts.some((x) => x.id === "unhandled_rejections"));
  // 50 for the part, the other parts of the area are 100: the area is below 100.
  assert.ok(a.score !== null && a.score < 100, `area score ${String(a.score)}`);
});

// Go: TestWithoutTheStrictRunTheCodeCorrectnessAreaIsNotFullyMeasuredAndTheScoreHasARange.
test("without the strict run the Code correctness area is not fully measured and the score has a range", () => {
  const p = scoredProject();
  p.deselect("runtime.unhandled-rejections");
  const b = score(p).benchmark;

  const got = part(b, "unhandled_rejections");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "deselected");
  // One unknown part leaves the area not fully measured, so it adds no
  // contribution; the single score comes from the other areas.
  const code = area(b, "code_correctness");
  assert.ok(!code.fully_measured);
  assert.equal(code.contribution, null);
  assert.ok(b.range && b.range.low < b.range.high, "a range");
});

// Go: TestAStrictRunThatDidNotFinishLeavesThePartUnknown.
test("a strict run that did not finish leaves the part unknown", () => {
  const p = scoredProject();
  p.status(
    "runtime.unhandled-rejections",
    StatusPartial,
    "repeat_run_timed_out",
  );
  const got = part(score(p).benchmark, "unhandled_rejections");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "partial: repeat_run_timed_out");
});
