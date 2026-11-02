import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atPath,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusTimedOut,
  StatusUnsupported,
} from "../resultset/types.ts";
import { indicator, score, wantScore } from "./benchmark.testutil.ts";
import { isCopyleft } from "./indicators.ts";

// Go: TestSideIndicatorsAreShownAndNeverChangeTheScore.
test("side indicators are shown and never change the score", () => {
  const clean = score(scoredProject()).benchmark;

  const p = scoredProject();
  for (let i = 0; i < 5; i++) {
    p.add("modules.cycles", "circular-import", false);
  }
  for (let i = 0; i < 40; i++) {
    p.add("quality.unused", "unused-export", false);
  }
  for (let i = 0; i < 9; i++) {
    p.add("types.javascript", "TS2339", false);
  }
  const noisy = score(p).benchmark;

  wantScore("import cycles", indicator(noisy, "import_cycles").value, 5);
  wantScore("unused exports", indicator(noisy, "unused_exports").value, 40);
  wantScore(
    "JSDoc type errors",
    indicator(noisy, "jsdoc_type_errors").value,
    9,
  );
  assert.equal(noisy.score, clean.score);
  assert.deepEqual(noisy.range, clean.range);
  assert.equal(noisy.verdict, clean.verdict);
});

// Go: TestTypeErrorsInTypeScriptFilesCountLikeThoseInJavaScriptFiles.
test("type errors in TypeScript files count like those in JavaScript files", () => {
  const p = scoredProject();
  p.add("types.javascript", "TS2345", false, atPath("src/a.js"));
  p.add("types.javascript", "TS2322", false, atPath("src/b.ts"));
  p.add("types.javascript", "TS2322", false, atPath("src/c.tsx"));

  const got = indicator(score(p).benchmark, "jsdoc_type_errors");

  wantScore("type errors", got.value, 3);
  assert.equal(got.state, PartMeasured);
});

// Go: TestATypeScriptPackageThatNeedsABuildStepLeavesTheTypeErrorIndicatorUnknownWithTheReason.
test("a TypeScript package that needs a build step leaves the type error indicator unknown with the reason", () => {
  const p = scoredProject();
  p.status("types.javascript", StatusUnsupported, "build_step_required");

  const got = indicator(score(p).benchmark, "jsdoc_type_errors");

  assert.equal(got.state, PartUnknown);
  assert.equal(got.value, null);
  assert.ok(got.reason?.includes("build_step_required"), String(got.reason));
});

// Go: TestEverySideIndicatorOfTheSpecHasARow.
test("every side indicator of the spec has a row", () => {
  const b = score(scoredProject()).benchmark;
  for (const id of [
    "coverage",
    "complexity",
    "duplication",
    "import_cycles",
    "unused_files",
    "unused_exports",
    "unused_dependencies",
    "jsdoc_type_errors",
    "runtime_warnings",
    "unknown_licenses",
    "copyleft_licenses",
    "install_scripts",
    "source_code_lines",
  ]) {
    indicator(b, id);
  }
});

// Go: TestCoverageAndRuntimeWarningsAreUnknownUntilTheirChecksTakePart.
test("coverage and runtime warnings are unknown until their Checks take part", () => {
  const b = score(scoredProject()).benchmark;
  for (const id of ["coverage", "runtime_warnings"]) {
    const got = indicator(b, id);
    assert.equal(got.state, PartUnknown, id);
    assert.equal(got.value, null, id);
  }
});

// Go: TestCoverageMetricsAppearAsIndicatorsWhenTheCheckRuns.
test("coverage Metrics appear as indicators when the Check runs", () => {
  const p = scoredProject();
  p.addExecution("tests.coverage", "C-0002");
  p.metric("tests.coverage", "lines_percent", 81.25, "percent");
  p.metric("tests.coverage", "branches_percent", 60, "percent");
  const b = score(p).benchmark;
  const lines = indicator(b, "coverage.lines_percent");
  wantScore("lines", lines.value, 81.25);
  assert.equal(lines.unit, "percent");
  assert.equal(lines.state, PartMeasured);
  wantScore("branches", indicator(b, "coverage.branches_percent").value, 60);
});

// Go: TestRuntimeWarningsCountTheFindingsOfTheCheck.
test("runtime warnings count the Findings of the Check", () => {
  const p = scoredProject();
  p.addExecution("runtime.warnings", "C-0002");
  p.add("runtime.warnings", "DEP0005", false);
  p.add("runtime.warnings", "open-handle", false);
  const got = indicator(score(p).benchmark, "runtime_warnings");
  wantScore("runtime warnings", got.value, 2);
  assert.equal(got.state, PartMeasured);
});

// Go: TestLicenseAndInstallScriptCounts.
test("license and install script counts", () => {
  const p = scoredProject();
  p.metric("security.licenses", "license:MIT", 120, "packages");
  p.metric("security.licenses", "license:none_in_lockfile", 3, "packages");
  p.metric("security.licenses", "license:GPL-3.0-only", 2, "packages");
  p.metric("security.licenses", "license:(MIT OR LGPL-2.1)", 1, "packages");
  p.metric("security.licenses", "license:Apache-2.0", 30, "packages");
  p.metric("package.install-scripts", "install_scripts", 4, "packages");
  p.metric("package.install-scripts", "install_script:esbuild", 1, "packages");
  const b = score(p).benchmark;
  wantScore(
    "packages without a license",
    indicator(b, "unknown_licenses").value,
    3,
  );
  assert.equal(
    indicator(b, "unknown_licenses").label,
    "Packages without a license in the lockfile",
  );
  wantScore("copyleft licenses", indicator(b, "copyleft_licenses").value, 3);
  wantScore("install scripts", indicator(b, "install_scripts").value, 4);
});

// Go: TestComplexityDuplicationAndSizeIndicators.
test("complexity, duplication and size indicators", () => {
  const p = scoredProject();
  p.metric("quality.metrics", "functions_above_cyclomatic_10", 7, "functions");
  p.metric("quality.metrics", "functions_above_cognitive_15", 4, "functions");
  p.metric("quality.metrics", "cyclomatic_p90", 6, "complexity");
  p.metric("quality.clones", "duplication_percent_source", 3.5, "percent");
  // The indicator counts JavaScript and TypeScript only; the Source code
  // class total (which holds lockfiles and OpenAPI files too) is not it.
  p.metric("quality.size", "lines.file_class:source", 40223, "lines");
  p.metric(
    "quality.size",
    "lines.source_code:javascript_typescript",
    9700,
    "lines",
  );
  const b = score(p).benchmark;
  wantScore("cyclomatic", indicator(b, "complexity.cyclomatic_10").value, 7);
  wantScore("cognitive", indicator(b, "complexity.cognitive_15").value, 4);
  wantScore("duplication", indicator(b, "duplication.source").value, 3.5);
  const lines = indicator(b, "source_code_lines");
  wantScore(
    "lines of JavaScript and TypeScript in Source code",
    lines.value,
    9700,
  );
  assert.equal(
    lines.label,
    "Lines of JavaScript and TypeScript in Source code",
  );
  assert.equal(lines.unit, "lines");
  const ids = b.side_indicators.map((s) => s.id);
  assert.ok(
    !ids.includes("source_lines"),
    "the old source_lines indicator is still reported",
  );
  assert.ok(
    !ids.includes("complexity.cyclomatic_p90"),
    "a percentile metric is not a threshold count",
  );
});

// Go: TestAnIndicatorWhoseCheckDidNotCompleteHasNoValue.
test("an indicator whose Check did not complete has no value", () => {
  const p = scoredProject();
  p.status("modules.cycles", StatusTimedOut, "timed_out");
  const got = indicator(score(p).benchmark, "import_cycles");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.value, null);
});

// No Go counterpart: the copyleft reading of license expressions, including
// the RE2 `.` (any character but a newline) that the pattern's tails use.
test("a license expression is copyleft when any identifier is", () => {
  for (const [license, want] of [
    ["MIT", false],
    ["GPL-3.0-only", true],
    ["(MIT OR lgpl-2.1)", true],
    ["Apache-2.0/MPL-2.0", true],
    ["CC-BY-NC-SA-4.0", true],
    ["CC-BY-4.0", false],
    ["AGPL", true],
    ["GPLv3", false],
    ["GPL-3.0\r", true],
    ["GPL-3.0\nx", false],
  ] as const) {
    assert.equal(isCopyleft(license), want, JSON.stringify(license));
  }
});
