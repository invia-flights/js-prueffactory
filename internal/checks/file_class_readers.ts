// The Checks that read the File class of files, and so wait for the test file
// probe (Check.readsFileClasses; Go: file_class_readers.go): the Checks of the
// combined ESLint run, which lints Test code with Mocha's globals and apart
// from Source code, the size, metrics, clone, Suppression and unused-code
// Checks, the module cycle and types Checks, which examine Source code only,
// and the Checks that run the Suites, which exclude Test code from Coverage
// and compare the files the runner loaded with the classes. The Inventory's
// Test code hashes are part of quality.suppressions.
//
// A Check that reads only Test data or Build output, which the probe never
// changes, is not listed: syntax.parse, schema.compile, artifacts.structured,
// lint.existing, api.lint and the repository Checks.
import { clones } from "./clones.ts";
import { depsEngines } from "./deps_engines.ts";
import { lintCorrectness } from "./lint_correctness.ts";
import { cycles } from "./modules_cycles.ts";
import { qualityMetrics } from "./quality_metrics.ts";
import { qualitySize } from "./quality_size.ts";
import { qualitySuppressions } from "./quality_suppressions.ts";
import { unused } from "./quality_unused.ts";
import { runtimeWarnings } from "./runtime_warnings.ts";
import { testsCoverage } from "./tests_coverage.ts";
import { testsExisting } from "./tests_existing.ts";
import { testsSmells } from "./tests_smells.ts";
import { typesJavascript } from "./types_javascript.ts";

const readsFileClasses = (): boolean => true;

for (const c of [
  qualityMetrics,
  qualitySize,
  clones,
  qualitySuppressions,
  unused,
  cycles,
  typesJavascript,
  lintCorrectness,
  depsEngines,
  testsSmells,
  testsExisting,
  testsCoverage,
  runtimeWarnings,
]) {
  c.readsFileClasses = readsFileClasses;
}
