// Seam A for the benchmark command: whole Runs on testdata projects, looking
// at the score, the Verdict and the exit code (Go: benchmark_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  benchmarkAreaOf,
  benchmarkPartOf,
  whole,
  type Whole,
} from "./whole.testutil.ts";

// executionKeys describes every Check execution of a Run by what the Check
// did, without anything that depends on the clock or the run ID.
function executionKeys(s: Whole): string[] {
  return s.checks
    .map(
      (e) =>
        `${e.check_id}|${e.context_id}|selected=${String(e.selected)}|${e.applicability}|${e.status}|${e.outcome}|${e.reason_code ?? ""}|gates=${String(e.gate)}|findings=${String(e.finding_ids.length)}`,
    )
    .sort(compareBytes);
}

test("benchmark on a clean project gives a single score and the Verdict pass", async (t) => {
  // Go: TestBenchmarkOnACleanProjectGivesASingleScoreAndVerdictPass
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["benchmark", original]);

  // An advisory is no Gate, so a clean project exits 0 whatever the advisory
  // database says today.
  assert.equal(r.code, 0, r.stderr);
  const s = whole(r);
  assert.deepEqual([s.run.command, s.run.exit_code], ["benchmark", 0]);
  const b = s.benchmark;
  assert.equal(b.status, "computed");
  assert.equal(b.profile_id, "benchmark-v2-uncalibrated");
  const score = b.score;
  assert.ok(
    score !== null && score >= 0 && score <= 100,
    `score = ${String(score)}, want a single score between 0 and 100`,
  );
  assert.equal(b.verdict, "pass");
  assert.deepEqual(b.gate_finding_ids, []);
  assert.ok(
    b.range !== null && b.range.low <= score && b.range.high >= score,
    `range ${JSON.stringify(b.range)} does not hold the score ${String(score)}`,
  );

  // Every part of the four areas the project has is measured.
  for (const a of b.areas) {
    if (a.exists) {
      assert.ok(a.fully_measured, `area ${a.id} is not fully measured`);
    }
  }
  const passRate = benchmarkPartOf(s, "pass_rate");
  assert.deepEqual(
    [passRate.state, passRate.score],
    ["measured", 100],
    "100 from the passing suite",
  );
  assert.equal(benchmarkPartOf(s, "secrets").score, 100);
  assert.equal(
    benchmarkPartOf(s, "helm").state,
    "not_applicable",
    "dropped: the project has no chart",
  );

  // The fingerprint names the environment the score belongs to.
  const f = b.fingerprint;
  assert.ok(f !== null, "no fingerprint");
  assert.equal(f.hash.length, 12);
  assert.equal(f.fields.runtimes.length, 1);
  assert.ok(f.fields.eslint_config_hashes.length > 0);
  assert.ok(f.fields.image_digests.length > 0);
  assert.ok(f.fields.advisory_database_date !== null);
  assert.notEqual(f.fields.toolset_version, "");
  assert.ok(b.side_indicators.length > 0, "no side indicators");

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  for (const want of [
    "**Score: ",
    " of 100**",
    "Verdict: **pass**",
    "benchmark-v2-uncalibrated",
    "comparable only between Runs with equal fingerprints",
    f.hash,
  ]) {
    assert.ok(md.includes(want), `report.md lacks ${want}`);
  }

  assert.equal(s.source.original_unchanged, true);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("benchmark on a Jest project has no score but a range and the Verdict incomplete", async (t) => {
  // Go: TestBenchmarkOnAJestProjectHasNoScoreButARangeAndVerdictIncomplete
  const original = copyProject(t, "jest-unsupported");

  const r = await realRun(t, ["benchmark", original]);

  assert.equal(r.code, 2, `the same as test\n${r.stderr}`);
  const s = whole(r);
  const b = s.benchmark;
  assert.equal(b.status, "incomplete");
  assert.equal(b.score, null, "incomplete without a score");
  assert.ok(
    b.range !== null && b.range.low < b.range.high,
    `range ${JSON.stringify(b.range)}, want a range with a gap`,
  );
  assert.equal(b.verdict, "incomplete");
  const p = benchmarkPartOf(s, "pass_rate");
  assert.equal(p.state, "unknown");
  assert.ok(
    p.reason?.includes("unsupported"),
    `pass rate reason ${String(p.reason)}, want unknown because the runner is unsupported`,
  );
  assert.equal(p.score, null);
  const tests = benchmarkAreaOf(s, "tests");
  assert.equal(tests.fully_measured, false);
  assert.equal(tests.score, null);
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes("**Score: none**") && md.includes("Range: "),
    "report.md does not say there is no single score and show the range",
  );
  assertNothingLeft(r);
});

test("benchmark on a broken lockfile scores the tests area zero", async (t) => {
  // Go: TestBenchmarkOnABrokenLockfileScoresTheTestsAreaZero
  const original = copyProject(t, "lockfile-mismatch");

  const r = await realRun(t, ["benchmark", original]);

  assert.equal(r.code, 1, `the install is a Gate\n${r.stderr}`);
  const s = whole(r);
  const b = s.benchmark;
  assert.equal(b.verdict, "fail");
  assert.ok(b.gate_finding_ids.length > 0, "want gate findings");
  assert.equal(benchmarkAreaOf(s, "tests").score, 0);
  const p = benchmarkPartOf(s, "pass_rate");
  assert.equal(p.state, "project_fault");
  assert.equal(p.reason, "prerequisite_failed_project");
  assert.equal(benchmarkPartOf(s, "install").score, 0);
  // The Gate does not take the score away.
  assert.notEqual(
    b.score,
    null,
    "no score although the project's fault counts as 0",
  );
  assertNothingLeft(r);
});

test("benchmark measures the type errors of a package with TypeScript files instead of leaving them unknown", async (t) => {
  // Go: TestBenchmarkMeasuresTypeErrorsOfAPackageWithTypeScriptFilesInsteadOfLeavingThemUnknown
  const original = copyProject(t, "types-mixed-ts");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "types.javascript",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const side = whole(r).benchmark.side_indicators.find(
    (x) => x.id === "jsdoc_type_errors",
  );
  assert.ok(side, "no jsdoc_type_errors side indicator");
  assert.equal(side.state, "measured");
  assert.equal(
    side.value,
    2,
    "measured with the JSDoc mismatch and the TypeScript error",
  );
});

test("benchmark and test run exactly the same Checks with the same exit code", async (t) => {
  // Go: TestBenchmarkAndTestRunExactlyTheSameChecksWithTheSameExitCode
  const original = copyProject(t, "syntax-error");
  // tests.existing is left out: the test script names Mocha, which this
  // project does not install.
  const args = [original, "--exclude", "tests.existing"];

  const tr = await realRun(t, ["test", ...args]);
  const br = await realRun(t, ["benchmark", ...args]);

  assert.deepEqual(
    [tr.code, br.code],
    [1, 1],
    `want 1 for both\nbenchmark stderr:\n${br.stderr}`,
  );
  const ts = whole(tr);
  const bs = whole(br);
  assert.deepEqual(
    executionKeys(bs),
    executionKeys(ts),
    "benchmark executions differ from test",
  );
  assert.equal(ts.benchmark.status, "not_requested");
  assert.deepEqual(
    [ts.benchmark.score, ts.benchmark.range, ts.benchmark.verdict],
    [null, null, null],
  );
  const md = readFileSync(join(tr.reportDir, "report.md"), "utf8");
  assert.ok(
    md.includes("No Benchmark score computed in test mode"),
    "the test mode report.md does not say that no score was computed",
  );

  // The Gate decides the Verdict and nothing else.
  assert.equal(bs.benchmark.verdict, "fail");
  assert.equal(
    benchmarkPartOf(bs, "syntax").score,
    50,
    "one source file fails to parse and the one in Test data does not count",
  );
  assertNothingLeft(tr);
  assertNothingLeft(br);
});
