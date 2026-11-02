import assert from "node:assert/strict";
import { test } from "node:test";

import { SHA } from "../resultset/resultsettest/sample.testutil.ts";
import {
  atPath,
  inTestCode,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusUnsupported,
} from "../resultset/types.ts";
import {
  area,
  fingerprintOf,
  part,
  score,
  wantScore,
} from "./benchmark.testutil.ts";

// The Typed lint part of the Code correctness area is the n_eff of the
// lint.typed Findings in Source code, x50 = 5. Test code is linted and
// reported, and never counts. Expected scores are worked out by hand from
// n_eff = sum over rules of (1 + log2(count)) and S = 100 * 2^(-n_eff / x50).

function withTypedLint(): Project {
  const p = scoredProject();
  p.addExecution("lint.typed", "C-0002");
  return p;
}

// Go: TestTypedLintDampsRepeatedHitsOfOneRuleAndScoresNEffAgainstFive.
test("typed lint damps repeated hits of one rule and scores n_eff against 5", () => {
  const p = withTypedLint();
  for (let i = 0; i < 4; i++) {
    p.add("lint.typed", "@typescript-eslint/no-floating-promises", false);
  }
  p.add("lint.typed", "@typescript-eslint/await-thenable", false);
  const b = score(p).benchmark;

  const got = part(b, "typed_lint");
  assert.equal(got.state, PartMeasured);
  assert.equal(got.raw_unit, "hits");
  // Four hits of one rule count 1 + log2(4) = 3, the other rule 1: n_eff 4.
  wantScore("raw value", got.raw_value, 5);
  wantScore("n_eff", got.n_eff, 4);
  wantScore("part score: 100 * 2^(-4/5)", got.score, 57.4);
  assert.equal(got.x50, 5);
  assert.deepEqual(got.source_checks, ["lint.typed"]);
  assert.ok(
    area(b, "code_correctness").parts.some((x) => x.id === "typed_lint"),
  );
});

// Go: TestTypedLintFindingsInTestCodeAreReportedButDoNotCount.
test("typed lint Findings in Test code are reported but do not count", () => {
  const p = withTypedLint();
  p.add("lint.typed", "@typescript-eslint/no-floating-promises", false);
  for (let i = 0; i < 6; i++) {
    p.add(
      "lint.typed",
      "@typescript-eslint/no-misused-promises",
      false,
      atPath("test/a.test.js"),
      inTestCode,
    );
  }
  const got = part(score(p).benchmark, "typed_lint");

  // Only the one Source code hit counts: n_eff 1, 100 * 2^(-1/5).
  wantScore("raw value", got.raw_value, 1);
  wantScore("n_eff", got.n_eff, 1);
  wantScore("part score", got.score, 87.1);
});

// Go: TestTypedLintWithHitsOnlyInTestCodeIsMeasuredAndPerfect.
test("typed lint with hits only in Test code is measured and perfect", () => {
  const p = withTypedLint();
  p.add(
    "lint.typed",
    "@typescript-eslint/await-thenable",
    false,
    atPath("test/a.test.js"),
    inTestCode,
  );
  const got = part(score(p).benchmark, "typed_lint");

  assert.equal(got.state, PartMeasured);
  wantScore("part score", got.score, 100);
});

// Go: TestTypedLintIsUnknownWhenTheCheckDidNotComplete.
test("typed lint is unknown when the Check did not complete", () => {
  const p = withTypedLint();
  p.status("lint.typed", StatusUnsupported, "build_step_required");

  const got = part(score(p).benchmark, "typed_lint");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.score, null);
});

// Go: TestTheTypedLintRuleListHashIsPartOfTheFingerprint.
test("the typed lint rule list hash is part of the fingerprint", () => {
  const withRules = (hash: string) => {
    const p = scoredProject();
    p.set.contexts[1]?.tools.push({
      name: "typed-lint-rules",
      version: hash.slice(0, 12),
      digest: hash,
    });
    return p;
  };
  const a = "ab" + SHA.slice(2);
  const base = fingerprintOf(withRules(a));

  assert.equal(base.fields.typed_lint_rules_hash, a);
  assert.notEqual(
    fingerprintOf(withRules("cd" + SHA.slice(2))).hash,
    base.hash,
  );
  const none = fingerprintOf(scoredProject());
  assert.equal(none.fields.typed_lint_rules_hash, null);
  assert.notEqual(none.hash, base.hash);
});
