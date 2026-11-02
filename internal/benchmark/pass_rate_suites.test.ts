import { test } from "node:test";

import {
  atPath,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  inSuite,
  part,
  score,
  suiteFile,
  wantScore,
} from "./benchmark.testutil.ts";

// The Pass rate is the mean over (suite, test file) pairs. A file that two
// suites load counts once per suite, and a failing Suite cannot hide behind a
// passing one.

// Go: TestThePassRateAveragesOverSuiteAndFilePairs.
test("the pass rate averages over suite and file pairs", () => {
  const p = scoredProject();
  // The unit layer passes completely, the api layer half of the same file:
  // (1 + 0.5) / 2. Keyed by file alone, one layer would overwrite the other.
  p.testFiles(
    suiteFile("test:unit", "test/shared.test.js", 4, 4),
    suiteFile("test:api", "test/shared.test.js", 4, 2),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 75);
});

// Go: TestAFileLoadedByTwoSuitesCountsOncePerSuite.
test("a file loaded by two suites counts once per suite", () => {
  const p = scoredProject();
  // Pairs: unit/a 1, unit/shared 1, api/shared 0 -> 2/3. Over files it would be 1/2.
  p.testFiles(
    suiteFile("test:unit", "test/a.test.js", 2, 2),
    suiteFile("test:unit", "test/shared.test.js", 2, 2),
    suiteFile("test:api", "test/shared.test.js", 2, 0),
  );
  wantScore(
    "pass rate",
    part(score(p).benchmark, "pass_rate").score,
    (100 * 2) / 3,
  );
});

// Go: TestASuiteThatFailsToLoadIsOnePairWithRateZero.
test("a suite that fails to load is one pair with rate 0", () => {
  const p = scoredProject();
  p.testFiles(suiteFile("test:unit", "test/a.test.js", 4, 4));
  // The api suite stopped before it reported any test: its Finding points at
  // the manifest. It is one pair with rate 0, next to the unit pair with 1.
  p.add(
    "tests.existing",
    "test-file-load-failed",
    true,
    atPath("package.json"),
    inSuite("test:api"),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 50);
});

// Go: TestAFileThatFailedToLoadInOneSuiteDoesNotHideBehindTheSameFileInAnother.
test("a file that failed to load in one suite does not hide behind the same file in another", () => {
  const p = scoredProject();
  p.testFiles(suiteFile("test:unit", "test/a.test.js", 4, 4));
  p.add(
    "tests.existing",
    "test-file-load-failed",
    true,
    atPath("test/a.test.js"),
    inSuite("test:api"),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 50);
});

// Go: TestSingleSuiteResultsScoreAsBefore.
test("single suite results score as before", () => {
  const p = scoredProject();
  p.testFiles(
    suiteFile("scripts.test", "test/big.test.js", 100, 100),
    suiteFile("scripts.test", "test/small.test.js", 2, 1),
  );
  wantScore("pass rate", part(score(p).benchmark, "pass_rate").score, 75);
});
