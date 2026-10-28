package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Pass rate is the mean over (suite, test file) pairs. A file that two
// suites load counts once per suite, and a failing Suite cannot hide behind a
// passing one.

func suiteFile(suite, name string, found, passed int) resultset.TestFileCount {
	return resultset.TestFileCount{Suite: suite, File: name, Found: found, Passed: passed}
}

func inSuite(suite string) func(*resultset.Finding) {
	return func(f *resultset.Finding) { f.Suite = &suite }
}

func TestThePassRateAveragesOverSuiteAndFilePairs(t *testing.T) {
	p := resultsettest.ScoredProject()
	// The unit layer passes completely, the api layer half of the same file:
	// (1 + 0.5) / 2. Keyed by file alone, one layer would overwrite the other.
	p.TestFiles(
		suiteFile("test:unit", "test/shared.test.js", 4, 4),
		suiteFile("test:api", "test/shared.test.js", 4, 2),
	)
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 75)
}

func TestAFileLoadedByTwoSuitesCountsOncePerSuite(t *testing.T) {
	p := resultsettest.ScoredProject()
	// Pairs: unit/a 1, unit/shared 1, api/shared 0 -> 2/3. Over files it would be 1/2.
	p.TestFiles(
		suiteFile("test:unit", "test/a.test.js", 2, 2),
		suiteFile("test:unit", "test/shared.test.js", 2, 2),
		suiteFile("test:api", "test/shared.test.js", 2, 0),
	)
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 100.0*2/3)
}

func TestASuiteThatFailsToLoadIsOnePairWithRateZero(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(suiteFile("test:unit", "test/a.test.js", 4, 4))
	// The api suite stopped before it reported any test: its Finding points at
	// the manifest. It is one pair with rate 0, next to the unit pair with 1.
	p.Add("tests.existing", "test-file-load-failed", true, resultsettest.AtPath("package.json"), inSuite("test:api"))
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 50)
}

func TestAFileThatFailedToLoadInOneSuiteDoesNotHideBehindTheSameFileInAnother(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(suiteFile("test:unit", "test/a.test.js", 4, 4))
	p.Add("tests.existing", "test-file-load-failed", true, resultsettest.AtPath("test/a.test.js"), inSuite("test:api"))
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 50)
}

func TestSingleSuiteResultsScoreAsBefore(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(suiteFile("scripts.test", "test/big.test.js", 100, 100), suiteFile("scripts.test", "test/small.test.js", 2, 1))
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 75)
}
