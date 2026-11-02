import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../benchmark/score.ts";
import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  type Set,
  TrustUntrusted,
} from "../resultset/types.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import { newEvidence } from "../resultset/zero.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { md } from "./render.testutil.ts";

// A Flaky test Finding lists the outcome, attempts and error of every run as
// Evidence, and the native command that runs the one test.

const runOne = "run 1 (first run): passed";
const runTwo =
  "run 2: failed, 1 attempt\n  attempt 1 (final): failed: counter was 2 and not 1";
const runThree =
  "run 3: passed after 2 attempts\n  attempt 1: failed: socket hang up\n  attempt 2 (final): passed";

function flakyFinding(f: Finding): void {
  f.confidence = ConfidenceConfirmed;
  f.title =
    "Flaky test: counter resets once (runs: passed, failed, passed after 2 attempts)";
  f.message = "The test passed in 2 of 3 runs.";
  for (const text of [runOne, runTwo, runThree]) {
    f.evidence.push(
      newEvidence({
        kind: "test_run",
        text,
        origin: "mocha",
        trust: TrustUntrusted,
      }),
    );
  }
  f.reproduction.test = {
    runner: "mocha",
    file: "test/counter.test.js",
    full_title: "counter resets once",
    native_command: [
      "npx",
      "mocha",
      "--fgrep",
      "counter resets once",
      "test/counter.test.js",
    ],
  };
}

function flakySet(): Set {
  const p = scoredProject();
  p.add("tests.flaky", "flaky-test", false, flakyFinding);
  const s = p.done();
  apply(s);
  assert.deepEqual(validateRules(s), [], "fixture is inconsistent");
  return s;
}

// Go: TestTheJSONReportHoldsTheOutcomeOfEveryRunAsEvidenceAndValidates.
test("report.json holds the outcome of every run as Evidence and validates", () => {
  const data = json(flakySet());
  assert.deepEqual(validate(data), []);
  const doc = JSON.parse(Buffer.from(data).toString("utf8")) as {
    findings: {
      check_id: string;
      severity: string;
      gate: boolean;
      evidence: { text: string; trust: string }[];
      reproduction: { test: { native_command: string[] } };
    }[];
  };
  const flaky = doc.findings.filter((f) => f.check_id === "tests.flaky");
  assert.equal(flaky.length, 1, "no tests.flaky Finding in report.json");
  for (const f of flaky) {
    assert.equal(f.severity, "warning");
    assert.equal(f.gate, false);
    assert.deepEqual(
      f.evidence.map((e) => [e.text, e.trust]),
      [runOne, runTwo, runThree].map((t) => [t, "untrusted_data"]),
    );
    assert.equal(
      f.reproduction.test.native_command.join(" "),
      "npx mocha --fgrep counter resets once test/counter.test.js",
    );
  }
});

// Go: TestTheMarkdownListsTheFlakyTestWithTheOutcomeOfEveryRunInItsTitle.
// report.md lists a Finding that is no Gate in one line. The title carries the
// outcome of every run, so a reader sees the three at a glance; the evidence
// of each run is in report.json.
test("report.md lists the Flaky test with the outcome of every run in its title", () => {
  const text = md(flakySet());
  for (const want of [
    "#### tests.flaky",
    "[warning] `src/a.js:1`: Flaky test: counter resets once (runs: passed, failed, passed after 2 attempts)",
    "Flaky tests",
  ]) {
    assert.ok(text.includes(want), `report.md lacks ${want}`);
  }
});
