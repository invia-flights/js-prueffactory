import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { at, goldenScored, goOracle } from "./helpers.testutil.ts";
import { minimal } from "./resultsettest/sample.testutil.ts";
import { scoredProject } from "./resultsettest/scored.testutil.ts";
import {
  BenchmarkIncomplete,
  BenchmarkNotRequested,
  type Set,
} from "./types.ts";
import { validate } from "./validate.ts";

// The Go tests score the scored project with benchmark.Apply. Until the scorer
// is ported (ticket 06), the baselines are the golden benchmark-pass Report
// (no Gate) and benchmark-fail Report (one Gate), whose Benchmark sections the
// Go scorer wrote; the oracle recorded the Go messages from the same
// baselines.

test("a scored set is valid", () => {
  assert.deepEqual(validate(goldenScored("benchmark-pass")), [], "pass");
  assert.deepEqual(
    validate(goldenScored("benchmark-fail")),
    [],
    "fail, with a Gate",
  );
});

type Baseline = "benchmark-pass" | "benchmark-fail";
const fired: Baseline = "benchmark-fail";
const clean: Baseline = "benchmark-pass";

const mutations: Record<
  string,
  [baseline: Baseline, mutate: (s: Set) => void, want: string]
> = {
  "pass although a Gate fired": [
    fired,
    (s) => {
      s.benchmark.verdict = "pass";
    },
    "disagrees with",
  ],
  "fail without a Gate": [
    clean,
    (s) => {
      s.benchmark.verdict = "fail";
    },
    "disagrees with",
  ],
  "incomplete with a score": [
    clean,
    (s) => {
      s.benchmark.verdict = "incomplete";
    },
    "incomplete verdict",
  ],
  "pass without a score": [
    clean,
    (s) => {
      s.benchmark.score = null;
      s.benchmark.status = BenchmarkIncomplete;
    },
    "pass without a score",
  ],
  "computed without a score": [
    clean,
    (s) => {
      s.benchmark.score = null;
      s.benchmark.verdict = "incomplete";
    },
    "computed but has no score",
  ],
  "incomplete status with a score": [
    clean,
    (s) => {
      s.benchmark.status = BenchmarkIncomplete;
    },
    "incomplete but has a score",
  ],
  "score over 100": [
    clean,
    (s) => {
      s.benchmark.score = 101;
    },
    "outside 0 to 100",
  ],
  "score with a fraction below 0": [
    clean,
    (s) => {
      s.benchmark.score = -0.25;
    },
    "not to the score -0.2",
  ],
  "range upside down": [
    clean,
    (s) => {
      s.benchmark.range = { low: 80.25, high: 20 };
    },
    "range",
  ],
  "range in exponent form": [
    clean,
    (s) => {
      s.benchmark.range = { low: 1e-7, high: 1234567 };
    },
    "1e-07 to 1.234567e+06",
  ],
  "no range": [
    clean,
    (s) => {
      s.benchmark.range = null;
    },
    "range",
  ],
  "no verdict": [
    clean,
    (s) => {
      s.benchmark.verdict = null;
    },
    "no verdict",
  ],
  "no profile ID": [
    clean,
    (s) => {
      s.benchmark.profile_id = null;
    },
    "no profile ID",
  ],
  "profile differs from profiles.benchmark_profile": [
    clean,
    (s) => {
      s.profiles.benchmark_profile = "other";
    },
    "profile",
  ],
  "gate list misses a Gate": [
    fired,
    (s) => {
      s.benchmark.gate_finding_ids = [];
    },
    "Gate",
  ],
  "gate list holds a Finding that is no Gate": [
    fired,
    (s) => {
      s.benchmark.gate_finding_ids.push("F-0099");
    },
    "Gate",
  ],
  "no areas": [
    clean,
    (s) => {
      s.benchmark.areas = [];
    },
    "areas",
  ],
  "no fingerprint": [
    clean,
    (s) => {
      s.benchmark.fingerprint = null;
    },
    "fingerprint",
  ],
  "contributions do not add up to the score": [
    clean,
    (s) => {
      at(s.benchmark.areas, 0).contribution = 1;
    },
    "contribution",
  ],
  "contribution without a score": [
    clean,
    (s) => {
      s.benchmark.score = null;
      s.benchmark.status = BenchmarkIncomplete;
      s.benchmark.verdict = "incomplete";
    },
    "has a contribution but there is no score",
  ],
  "summary gates differ": [
    fired,
    (s) => {
      s.summary.gates = 3;
    },
    "summary counts 3 Gates",
  ],
  "benchmark section in a test mode Report": [
    clean,
    (s) => {
      s.run.command = "test";
    },
    "test mode",
  ],
};

describe("the validator catches a score that disagrees with its Verdict, with the Go build's messages", () => {
  for (const [name, [baseline, mutate, want]] of Object.entries(mutations)) {
    test(name, () => {
      const s = goldenScored(baseline);
      assert.deepEqual(validate(s), [], "the baseline is not valid");
      mutate(s);
      const problems = validate(s);
      assert.notDeepEqual(
        problems,
        [],
        "the validator accepted the broken set",
      );
      assert.ok(
        problems.join("\n").includes(want),
        `problems ${JSON.stringify(problems)} lack ${want}`,
      );
      assert.deepEqual(problems, goOracle.validation[`scored: ${name}`]);
    });
  }
});

test("a benchmark mode Report must carry a benchmark section", () => {
  const s = scoredProject().done();
  s.run.command = "benchmark";
  const problems = validate(s);
  assert.ok(
    problems.join("\n").includes("benchmark command"),
    JSON.stringify(problems),
  );
  assert.deepEqual(
    problems,
    goOracle.validation["benchmark command without a benchmark section"],
  );
});

test("a test mode Report keeps its section not_requested", () => {
  const s = minimal();
  assert.equal(s.run.command, "test");
  assert.equal(s.benchmark.status, BenchmarkNotRequested);
  assert.deepEqual(validate(s), [], "a test mode Report is valid");
  s.benchmark.areas = goldenScored("benchmark-pass").benchmark.areas;
  const problems = validate(s);
  assert.ok(
    problems.join("\n").includes("not_requested"),
    JSON.stringify(problems),
  );
  assert.deepEqual(
    problems,
    goOracle.validation["test mode Report with benchmark areas"],
  );
});
