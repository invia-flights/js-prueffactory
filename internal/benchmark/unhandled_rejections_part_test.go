package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Unhandled rejections part of the Code correctness area counts the Findings
// of runtime.unhandled-rejections, x50 = 2. Expected scores are worked out by
// hand from S = 100 * 2^(-x / x50).

func TestTwoUnhandledRejectionFindingsHalveThePartAndTheCodeCorrectnessArea(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	b := score(t, p).Benchmark

	got := part(t, b, "unhandled_rejections")
	if got.State != resultset.PartMeasured {
		t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
	}
	wantScore(t, "raw value", got.RawValue, 2)
	wantScore(t, "part score", got.Score, 50)
	if got.NEff != nil {
		t.Errorf("n_eff = %v: the part counts Findings and does not damp", *got.NEff)
	}
	if got.X50 == nil || *got.X50 != 2 {
		t.Errorf("x50 = %v, want 2", got.X50)
	}
}

func TestACrashFindingCountsLikeATestFindingAndNoFindingScoresAHundred(t *testing.T) {
	p := resultsettest.ScoredProject()
	wantScore(t, "no Finding", part(t, score(t, p).Benchmark, "unhandled_rejections").Score, 100)

	p = resultsettest.ScoredProject()
	p.Add("runtime.unhandled-rejections", "unhandled-rejection-crash", false)
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	got := part(t, score(t, p).Benchmark, "unhandled_rejections")
	wantScore(t, "raw value", got.RawValue, 4)
	wantScore(t, "four Findings: 100 * 2^-2", got.Score, 25)
}

func TestTheUnhandledRejectionsPartBelongsToTheCodeCorrectnessArea(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	p.Add("runtime.unhandled-rejections", "unhandled-rejection", false)
	b := score(t, p).Benchmark

	a := area(t, b, "code_correctness")
	found := false
	for _, p := range a.Parts {
		found = found || p.ID == "unhandled_rejections"
	}
	if !found {
		t.Errorf("parts of the area = %+v", a.Parts)
	}
	// 50 for the part, the other parts of the area are 100: the area is below 100.
	if a.Score == nil || *a.Score >= 100 {
		t.Errorf("code correctness area = %v, want it pulled down by the part", a.Score)
	}
}

func TestWithoutTheStrictRunTheCodeCorrectnessAreaIsNotFullyMeasuredAndTheScoreHasARange(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Deselect("runtime.unhandled-rejections")
	b := score(t, p).Benchmark

	got := part(t, b, "unhandled_rejections")
	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "deselected" {
		t.Errorf("state = %s, reason = %v, want unknown: deselected", got.State, got.Reason)
	}
	// One unknown part leaves the area not fully measured, so it adds no
	// contribution; the single score comes from the other areas.
	code := area(t, b, "code_correctness")
	if code.FullyMeasured || code.Contribution != nil {
		t.Errorf("code correctness: fully measured %v, contribution %v", code.FullyMeasured, code.Contribution)
	}
	if b.Range == nil || b.Range.Low >= b.Range.High {
		t.Errorf("range = %+v, want a range", b.Range)
	}
}

func TestAStrictRunThatDidNotFinishLeavesThePartUnknown(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("runtime.unhandled-rejections", resultset.StatusPartial, "repeat_run_timed_out")
	got := part(t, score(t, p).Benchmark, "unhandled_rejections")
	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "partial: repeat_run_timed_out" {
		t.Errorf("state = %s, reason = %v", got.State, got.Reason)
	}
}
