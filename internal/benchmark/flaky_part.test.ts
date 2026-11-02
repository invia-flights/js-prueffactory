import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusPartial,
} from "../resultset/types.ts";
import { area, part, score, wantScore } from "./benchmark.testutil.ts";

// The Flaky tests part of the Tests area counts the Flaky test Findings of
// tests.flaky, x50 = 3. Expected scores are worked out by hand from
// S = 100 * 2^(-x / x50).

// Go: TestThreeFlakyTestsHalveTheFlakyTestsPart.
test("three Flaky tests halve the Flaky tests part", () => {
  const p = scoredProject();
  for (let i = 0; i < 3; i++) {
    p.add("tests.flaky", "flaky-test", false);
  }
  const b = score(p).benchmark;

  const got = part(b, "flaky_tests");
  assert.equal(got.state, PartMeasured);
  wantScore("raw value", got.raw_value, 3);
  wantScore("part score", got.score, 50);
  assert.equal(got.n_eff, null, "the part counts tests and does not damp");
  assert.equal(got.x50, 3);
  wantScore("tests area", area(b, "tests").score, 50);
});

// Go: TestNoFlakyTestsScoreAHundredAndRepeatedHitsOfOneRuleAreNotDamped.
test("no Flaky tests score 100 and repeated hits of one rule are not damped", () => {
  wantScore(
    "no Flaky test",
    part(score(scoredProject()).benchmark, "flaky_tests").score,
    100,
  );

  const p = scoredProject();
  for (let i = 0; i < 6; i++) {
    p.add("tests.flaky", "flaky-test", false);
  }
  const got = part(score(p).benchmark, "flaky_tests");
  wantScore("raw value", got.raw_value, 6);
  wantScore("six Flaky tests of one rule: 100 * 2^-2", got.score, 25);
});

// Go: TestATestFoundInOnlySomeRunsIsANoteAndIsNotCounted.
test("a test found in only some runs is a note and is not counted", () => {
  const p = scoredProject();
  p.add("tests.flaky", "flaky-test", false);
  p.add("tests.flaky", "test-in-some-runs", false);
  wantScore("raw value", part(score(p).benchmark, "flaky_tests").raw_value, 1);
});

// Go: TestFlakyTestsDoNotChangeThePassRate.
test("Flaky tests do not change the pass rate", () => {
  const p = scoredProject();
  for (let i = 0; i < 4; i++) {
    p.add("tests.flaky", "flaky-test", false);
  }
  const b = score(p).benchmark;
  wantScore("pass rate", part(b, "pass_rate").score, 100);
  wantScore("flaky tests", part(b, "flaky_tests").score, 39.7);
});

// Go: TestWithoutFlakyTestsDetectionTheTestsAreNotFullyMeasuredAndThereIsARangeNoScore.
test("without Flaky test detection the Tests are not fully measured and there is a range, no score", () => {
  const p = scoredProject();
  p.deselect("tests.flaky");
  const b = score(p).benchmark;

  const got = part(b, "flaky_tests");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "deselected");
  assert.equal(b.score, null, "the Tests area is not fully measured");
  assert.ok(b.range && b.range.low < b.range.high, "a range");
  wantScore("pass rate is still measured", part(b, "pass_rate").score, 100);
});

// Go: TestARepeatRunThatDidNotFinishLeavesTheFlakyTestsPartUnknown.
test("a repeat run that did not finish leaves the Flaky tests part unknown", () => {
  const p = scoredProject();
  p.status("tests.flaky", StatusPartial, "repeat_run_timed_out");
  const got = part(score(p).benchmark, "flaky_tests");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "partial: repeat_run_timed_out");
});
