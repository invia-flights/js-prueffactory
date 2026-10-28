package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Flaky tests part of the Tests area counts the Flaky test Findings of
// tests.flaky, x50 = 3. Expected scores are worked out by hand from
// S = 100 * 2^(-x / x50).

func TestThreeFlakyTestsHalveTheFlakyTestsPart(t *testing.T) {
	p := resultsettest.ScoredProject()
	for i := 0; i < 3; i++ {
		p.Add("tests.flaky", "flaky-test", false)
	}
	b := score(t, p).Benchmark

	got := part(t, b, "flaky_tests")
	if got.State != resultset.PartMeasured {
		t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
	}
	wantScore(t, "raw value", got.RawValue, 3)
	wantScore(t, "part score", got.Score, 50)
	if got.NEff != nil {
		t.Errorf("n_eff = %v: the part counts tests and does not damp", *got.NEff)
	}
	if got.X50 == nil || *got.X50 != 3 {
		t.Errorf("x50 = %v, want 3", got.X50)
	}
	wantScore(t, "tests area", area(t, b, "tests").Score, 50)
}

func TestNoFlakyTestsScoreAHundredAndRepeatedHitsOfOneRuleAreNotDamped(t *testing.T) {
	p := resultsettest.ScoredProject()
	wantScore(t, "no Flaky test", part(t, score(t, p).Benchmark, "flaky_tests").Score, 100)

	p = resultsettest.ScoredProject()
	for i := 0; i < 6; i++ {
		p.Add("tests.flaky", "flaky-test", false)
	}
	got := part(t, score(t, p).Benchmark, "flaky_tests")
	wantScore(t, "raw value", got.RawValue, 6)
	wantScore(t, "six Flaky tests of one rule: 100 * 2^-2", got.Score, 25)
}

func TestATestFoundInOnlySomeRunsIsANoteAndIsNotCounted(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("tests.flaky", "flaky-test", false)
	p.Add("tests.flaky", "test-in-some-runs", false)
	got := part(t, score(t, p).Benchmark, "flaky_tests")
	wantScore(t, "raw value", got.RawValue, 1)
}

func TestFlakyTestsDoNotChangeThePassRate(t *testing.T) {
	p := resultsettest.ScoredProject()
	for i := 0; i < 4; i++ {
		p.Add("tests.flaky", "flaky-test", false)
	}
	b := score(t, p).Benchmark
	wantScore(t, "pass rate", part(t, b, "pass_rate").Score, 100)
	wantScore(t, "flaky tests", part(t, b, "flaky_tests").Score, 39.7)
}

func TestWithoutFlakyTestsDetectionTheTestsAreNotFullyMeasuredAndThereIsARangeNoScore(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Deselect("tests.flaky")
	b := score(t, p).Benchmark

	got := part(t, b, "flaky_tests")
	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "deselected" {
		t.Errorf("state = %s, reason = %v, want unknown: deselected", got.State, got.Reason)
	}
	if b.Score != nil {
		t.Errorf("score = %v, want none: the Tests area is not fully measured", *b.Score)
	}
	if b.Range == nil || b.Range.Low >= b.Range.High {
		t.Errorf("range = %+v, want a range", b.Range)
	}
	wantScore(t, "pass rate is still measured", part(t, b, "pass_rate").Score, 100)
}

func TestARepeatRunThatDidNotFinishLeavesTheFlakyTestsPartUnknown(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("tests.flaky", resultset.StatusPartial, "repeat_run_timed_out")
	got := part(t, score(t, p).Benchmark, "flaky_tests")
	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "partial: repeat_run_timed_out" {
		t.Errorf("state = %s, reason = %v", got.State, got.Reason)
	}
}
