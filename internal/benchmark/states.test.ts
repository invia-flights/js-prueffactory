import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  BenchmarkComputed,
  BenchmarkIncomplete,
  PartNotApplicable,
  PartUnknown,
  StatusBudgetExhausted,
  StatusBlocked,
  StatusCancelled,
  StatusInfrastructureError,
  StatusPartial,
  StatusTimedOut,
  StatusToolError,
  StatusUnsupported,
  VerdictFail,
  VerdictIncomplete,
  VerdictPass,
} from "../resultset/types.ts";
import {
  advisory,
  area,
  assertProjectFault,
  fileCount,
  part,
  score,
  wantNull,
  wantScore,
} from "./benchmark.testutil.ts";

const validityChecks = [
  "package.manifest",
  "package.install",
  "syntax.parse",
  "artifacts.structured",
  "api.lint",
  "schema.compile",
  "repository.helm",
  "deps.tree",
  "repository.dockerfile",
  "repository.shell",
];

// Go: TestAPartThatDoesNotExistIsDroppedAndTheAreaKeepsItsOtherParts.
test("a part that does not exist is dropped and the area keeps its other parts", () => {
  const b = score(scoredProject()).benchmark;
  for (const id of [
    "openapi",
    "json_schema",
    "helm",
    "dockerfile_shell",
    "project_linter",
  ]) {
    const got = part(b, id);
    assert.equal(got.state, PartNotApplicable, id);
    wantNull(`${id} score`, got.score);
  }
  const v = area(b, "validity");
  assert.ok(v.exists && v.fully_measured);
});

// Go: TestAnAreaWithEveryPartDroppedIsDroppedAndTheOtherWeightsAreRenormalized.
test("an area with every part dropped is dropped and the other weights are renormalized", () => {
  const p = scoredProject();
  for (const id of validityChecks) {
    p.notApplicable(id);
  }
  // Security at 0 makes the weighting visible: 40*100 + 25*0 + 15*100 of 80.
  p.add("security.secrets", "generic-api-key", false);
  const b = score(p).benchmark;

  const v = area(b, "validity");
  assert.ok(!v.exists && !v.fully_measured, "validity is a dropped area");
  wantNull("validity score", v.score);
  wantNull("validity contribution", v.contribution);
  wantScore("score", b.score, 68.8);
  wantScore("tests contribution", area(b, "tests").contribution, 50);
  wantScore("security contribution", area(b, "security").contribution, 0);
  wantScore(
    "code contribution",
    area(b, "code_correctness").contribution,
    18.8,
  );
});

// Go: TestTheProjectsFaultCountsAsZeroAndKeepsTheScore.
test("the project's fault counts as 0 and keeps the score", () => {
  // The lockfile does not match package.json: the install fails, and what
  // needs the install is blocked because of the project, not the Run.
  const p = scoredProject();
  p.add("package.install", "lockfile-out-of-sync", true);
  for (const id of ["tests.existing", "deps.tree"]) {
    p.status(id, StatusBlocked, "prerequisite_failed_project");
  }
  p.testFiles();
  const b = score(p).benchmark;

  assertProjectFault(part(b, "pass_rate"), "prerequisite_failed_project");
  assertProjectFault(part(b, "dependency_tree"), "prerequisite_failed_project");
  wantScore("install", part(b, "install").score, 0);
  wantScore("tests area", area(b, "tests").score, 0);
  wantScore("validity area", area(b, "validity").score, 0);
  assert.notEqual(
    b.score,
    null,
    "the project's fault must not take the score away",
  );
  // Tests 0, Validity 0, Security 100, Code 100: 25 + 15.
  wantScore("score", b.score, 40);
  assert.equal(b.verdict, VerdictFail);
});

// Go: TestARunFailureMakesAPartUnknownAndTheRangeCoversBothEnds.
describe("a Run failure makes a part unknown and the range covers both ends", () => {
  const cases: [string, (p: Project) => void, string][] = [
    [
      "unsupported",
      (p) => {
        p.status(
          "tests.existing",
          StatusUnsupported,
          "test_runner_not_implemented",
        );
      },
      "unsupported: test_runner_not_implemented",
    ],
    [
      "timed out",
      (p) => {
        p.status("tests.existing", StatusTimedOut, "timed_out");
      },
      "timed_out: timed_out",
    ],
    [
      "budget exhausted",
      (p) => {
        p.status("tests.existing", StatusBudgetExhausted, "budget_exhausted");
      },
      "budget_exhausted: budget_exhausted",
    ],
    [
      "tool error",
      (p) => {
        p.status("tests.existing", StatusToolError, "no_test_events");
      },
      "tool_error: no_test_events",
    ],
    [
      "infrastructure error",
      (p) => {
        p.status(
          "tests.existing",
          StatusInfrastructureError,
          "registry_unreachable",
        );
      },
      "infrastructure_error: registry_unreachable",
    ],
    [
      "cancelled",
      (p) => {
        p.status("tests.existing", StatusCancelled, "");
      },
      "cancelled",
    ],
    [
      "blocked for a reason of the Run",
      (p) => {
        p.status(
          "tests.existing",
          StatusBlocked,
          "missing_registry_credentials",
        );
      },
      "blocked: missing_registry_credentials",
    ],
    [
      "partial",
      (p) => {
        p.status("tests.existing", StatusPartial, "out_of_memory");
      },
      "partial: out_of_memory",
    ],
    [
      "deselected",
      (p) => {
        p.deselect("tests.existing");
      },
      "deselected",
    ],
    [
      "deselected by --fast",
      (p) => {
        p.deselectByFast("tests.existing");
      },
      "deselected by --fast",
    ],
  ];
  for (const [name, mutate, why] of cases) {
    test(name, () => {
      const p = scoredProject();
      mutate(p);
      const b = score(p).benchmark;

      const got = part(b, "pass_rate");
      assert.equal(got.state, PartUnknown);
      assert.equal(got.reason, why);
      wantNull("part score", got.score);
      wantNull("raw value", got.raw_value);

      const tests = area(b, "tests");
      assert.ok(
        !tests.fully_measured,
        "the Tests area is fully measured with an unknown part",
      );
      wantNull("tests score", tests.score);
      // Unknown at 0: only Validity, Security and Code count. Unknown at
      // 100: the area stays at the minimum of its measured parts.
      wantScore("tests range low", tests.range?.low, 0);
      wantScore("tests range high", tests.range?.high, 100);
      wantScore("range low", b.range?.low, 60);
      wantScore("range high", b.range?.high, 100);

      wantNull("score", b.score);
      assert.equal(b.status, BenchmarkIncomplete);
      assert.equal(b.verdict, VerdictIncomplete);
    });
  }
});

// Go: TestTheHighEndOfTheRangeStaysAtTheMinimumOfTheMeasuredParts.
test("the high end of the range stays at the minimum of the measured parts", () => {
  const p = scoredProject();
  p.status("tests.existing", StatusUnsupported, "test_runner_not_implemented");
  // Smells at n_eff 5 score 50, so the Tests area cannot exceed 50.
  for (const rule of ["a", "b", "c", "d", "e"]) {
    p.add("tests.smells", "mocha/" + rule, false);
  }
  const b = score(p).benchmark;
  wantScore("tests range high", area(b, "tests").range?.high, 50);
  wantScore("range high", b.range?.high, 80); // 40% of 50 plus the other 60
  wantScore("range low", b.range?.low, 60);
});

// Go: TestAnUnknownSecurityPartTakesTheSingleScoreAway.
test("an unknown Security part takes the single score away", () => {
  const p = scoredProject();
  p.status(
    "security.dependencies",
    StatusInfrastructureError,
    "advisory_database_unavailable",
  );
  const b = score(p).benchmark;
  wantNull("score", b.score);
  wantScore("range low", b.range?.low, 75); // Security's vulnerabilities part at 0
  wantScore("range high", b.range?.high, 100);
});

// Go: TestADeselectedCheckIsUnknownSoNobodyRaisesAScoreByExcludingChecks.
test("a deselected Check is unknown, so nobody raises a score by excluding Checks", () => {
  // A secret would have scored Security 0; excluding the Check hides it.
  const hidden = scoredProject();
  hidden.deselect("security.secrets");
  const b = score(hidden).benchmark;
  assert.equal(part(b, "secrets").state, PartUnknown);
  wantNull("score", b.score);
  wantScore("range low", b.range?.low, 75);
});

// Go: TestTheSingleScoreNeedsEightyPercentOfTheExistingWeightMeasured.
test("one unknown Code correctness part still gives a score from the rest", () => {
  const p = scoredProject();
  p.deselect("lint.correctness");
  p.add(
    "security.dependencies",
    "GHSA-high",
    false,
    ...advisory("high", "prod"),
  );
  p.add(
    "security.dependencies",
    "GHSA-mod-1",
    false,
    ...advisory("moderate", "prod"),
  );
  p.add(
    "security.dependencies",
    "GHSA-mod-2",
    false,
    ...advisory("moderate", "prod"),
  );
  const b = score(p).benchmark;

  const code = area(b, "code_correctness");
  assert.ok(
    !code.fully_measured,
    "Code correctness is fully measured with an unknown part",
  );
  wantNull("code contribution", code.contribution);
  // (40*100 + 20*100 + 25*53.59) / 85, the unmeasured 15 left out.
  wantScore("score", b.score, 86.3);
  wantScore("tests contribution", area(b, "tests").contribution, 47.1);
  wantScore("range low", b.range?.low, 73.4); // 100*.40 + 100*.20 + 53.59*.25 + 0
  wantScore("range high", b.range?.high, 88.4);
  assert.equal(b.status, BenchmarkComputed);
  assert.equal(b.verdict, VerdictPass);
});

// Go: TestGatesNeverChangeTheScoreOrTheRange.
test("Gates never change the score or the range", () => {
  // A test that fails and a test that is skipped lower the pass rate the
  // same way. Only the failing one is a Gate.
  const skipped = scoredProject();
  skipped.testFiles(fileCount("test/a.test.js", 4, 3, 0));
  const without = score(skipped).benchmark;

  const failing = scoredProject();
  failing.testFiles(fileCount("test/a.test.js", 4, 3, 0));
  failing.add("tests.existing", "test-failed", true);
  const withGate = score(failing).benchmark;

  assert.notEqual(without.score, null);
  assert.equal(without.score, withGate.score);
  assert.deepEqual(without.range, withGate.range);
  assert.equal(without.verdict, VerdictPass);
  assert.equal(withGate.verdict, VerdictFail);
  assert.deepEqual(withGate.gate_finding_ids, ["F-0001"]);
});

// Go: TestAGateWithoutAScoreGivesVerdictFail.
test("a Gate without a score gives Verdict fail", () => {
  const p = scoredProject();
  p.status(
    "security.dependencies",
    StatusInfrastructureError,
    "advisory_database_unavailable",
  );
  p.add("syntax.parse", "SyntaxError", true);
  const b = score(p).benchmark;
  wantNull("score", b.score);
  assert.equal(b.verdict, VerdictFail);
  assert.notEqual(b.range, null, "the range is always computed");
});

// Go: TestTheScoreIsTheSameWhateverOrderTheResultsCameIn.
test("the score is the same whatever order the results came in", () => {
  const build = (reverse: boolean) => {
    const p = scoredProject();
    for (const r of reverse ? ["c", "b", "a"] : ["a", "b", "c"]) {
      p.add("lint.correctness", r, false);
    }
    if (reverse) {
      const checks = p.set.checks;
      const first = checks[0];
      const last = checks.at(-1);
      assert.ok(first && last);
      checks[0] = last;
      checks[checks.length - 1] = first;
    }
    return score(p).benchmark;
  };
  const a = build(false);
  const b = build(true);
  assert.equal(a.score, b.score);
  assert.equal(a.fingerprint?.hash, b.fingerprint?.hash);
});

// Go: TestAPartWhoseCheckIsPartialBecauseFilesDidNotParseIsUnknownAndTheRangeCoversIt.
// A package ESLint could not parse has no hits because nobody looked. The
// three Checks that read the ESLint run are then partial with
// files_not_parsed, and a partial Check is unknown, so the part is not scored
// as a clean 100. The existing policy decides what that does to the single
// score: an unknown part of the Tests area takes it away, while the Code area
// is not one of the areas a single score needs, so there the score stays and
// the area is shown as not fully measured, with the range around it.
describe("a part whose Check is partial because files did not parse is unknown and the range covers it", () => {
  const cases: [check: string, part: string, area: string, single: boolean][] =
    [
      ["lint.correctness", "correctness_lint", "code_correctness", true],
      ["deps.engines", "node_compatibility", "code_correctness", true],
      ["tests.smells", "smells", "tests", false],
    ];
  for (const [check, partID, areaID, single] of cases) {
    test(check, () => {
      const p = scoredProject();
      p.status(check, StatusPartial, "files_not_parsed");
      const b = score(p).benchmark;

      const got = part(b, partID);
      assert.equal(got.state, PartUnknown);
      assert.equal(got.reason, "partial: files_not_parsed");
      wantNull("part score", got.score);
      assert.ok(!area(b, areaID).fully_measured);
      assert.ok(b.range && b.range.low < b.range.high, "a real range");
      if (single) {
        assert.notEqual(
          b.score,
          null,
          "the Code area is not needed for a single score",
        );
        return;
      }
      wantNull("score", b.score);
      assert.equal(b.status, BenchmarkIncomplete);
      assert.equal(b.verdict, VerdictIncomplete);
    });
  }
});
