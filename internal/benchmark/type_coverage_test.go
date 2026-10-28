package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Type coverage is the one part that scores a percentage as it is, and the
// strict-gap error count is a side indicator. Expected values are worked out
// by hand.

// withTypeStrictness adds types.strictness to the clean project with its
// metrics for the package Context.
func withTypeStrictness(percent, identifiers, gap float64) *resultsettest.Project {
	p := resultsettest.ScoredProject()
	p.AddExecution("types.strictness", "C-0002")
	p.Metric("types.strictness", "type_coverage_percent", percent, "percent")
	p.Metric("types.strictness", "type_coverage_identifiers", identifiers, "identifiers")
	p.Metric("types.strictness", "strict_gap_errors", gap, "errors")
	return p
}

func TestTypeCoverageScoresItsPercentageDirectlyInCodeCorrectness(t *testing.T) {
	b := score(t, withTypeStrictness(82.5, 200, 0)).Benchmark

	got := part(t, b, "type_coverage")
	if got.State != resultset.PartMeasured || got.X50 != nil || got.RawUnit != "percent" {
		t.Errorf("part = %+v, want measured, percent, not count-based", got)
	}
	wantScore(t, "type coverage raw value", got.RawValue, 82.5)
	wantScore(t, "type coverage score", got.Score, 82.5)
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "types.strictness" {
		t.Errorf("source checks = %v", got.SourceChecks)
	}
	// The area is the minimum of its parts, and the other Code correctness
	// parts are clean.
	wantScore(t, "code correctness score", area(t, b, "code_correctness").Score, 82.5)
}

func TestTypeCoverageOfSeveralPackagesWeighsEachByItsIdentifiers(t *testing.T) {
	p := withTypeStrictness(100, 10, 0)
	// A second package: 30 identifiers at 50 percent. 10 + 15 typed of 40 is 62.5.
	p.Set.Contexts = append(p.Set.Contexts, resultset.Context{ID: "C-0003", Kind: "package", Path: "packages/b"})
	e := p.Set.Checks[len(p.Set.Checks)-1]
	e.ID, e.ContextID = "added-second", "C-0003"
	p.Set.Checks = append(p.Set.Checks, e)
	for name, v := range map[string]float64{"type_coverage_percent": 50, "type_coverage_identifiers": 30} {
		unit := "percent"
		if name == "type_coverage_identifiers" {
			unit = "identifiers"
		}
		val := v
		p.Set.Metrics = append(p.Set.Metrics, resultset.Metric{
			ID: "tmp-" + name + "-b", CheckID: "types.strictness", ContextID: "C-0003", Name: name, Value: &val, Unit: unit,
		})
	}

	wantScore(t, "type coverage", part(t, score(t, p).Benchmark, "type_coverage").Score, 62.5)
}

func TestTypeCoverageIsUnknownWhenTheCheckDidNotComplete(t *testing.T) {
	p := withTypeStrictness(90, 100, 0)
	p.Status("types.strictness", resultset.StatusUnsupported, "build_step_required")

	got := part(t, score(t, p).Benchmark, "type_coverage")

	if got.State != resultset.PartUnknown || got.Score != nil {
		t.Errorf("part = %+v, want unknown without a score", got)
	}
}

func TestTypeCoverageIsNotApplicableWithoutAPackageToExamine(t *testing.T) {
	p := withTypeStrictness(90, 100, 0)
	p.NotApplicable("types.strictness")

	if got := part(t, score(t, p).Benchmark, "type_coverage"); got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
}

func TestTheStrictGapIsASideIndicatorThatNeverChangesTheScore(t *testing.T) {
	quiet := score(t, withTypeStrictness(80, 100, 0)).Benchmark
	noisy := score(t, withTypeStrictness(80, 100, 1234)).Benchmark

	got := indicator(t, noisy, "strict_gap_errors")
	wantScore(t, "strict gap errors", got.Value, 1234)
	if got.State != resultset.PartMeasured || got.Unit != "errors" {
		t.Errorf("indicator = %+v", got)
	}
	if *noisy.Score != *quiet.Score || *noisy.Range != *quiet.Range || *noisy.Verdict != *quiet.Verdict {
		t.Errorf("the strict gap changed the result: score %v and %v", *quiet.Score, *noisy.Score)
	}
}

func TestTheStrictGapIsUnknownUntilTheCheckTakesPart(t *testing.T) {
	got := indicator(t, score(t, resultsettest.ScoredProject()).Benchmark, "strict_gap_errors")
	if got.State != resultset.PartUnknown || got.Value != nil {
		t.Errorf("indicator = %+v, want unknown without a value", got)
	}
}

func TestTheTypeScript6VersionIsPartOfTheFingerprint(t *testing.T) {
	tsVersion := func(v string) *resultsettest.Project {
		p := resultsettest.ScoredProject()
		p.Set.Contexts[1].Tools = append(p.Set.Contexts[1].Tools, resultset.ToolRef{Name: "typescript6", Version: v})
		return p
	}
	base := fingerprintOf(t, tsVersion("6.0.2"))

	if base.Fields.TypeScript6Version == nil || *base.Fields.TypeScript6Version != "6.0.2" {
		t.Errorf("typescript6 version = %v, want 6.0.2", base.Fields.TypeScript6Version)
	}
	if other := fingerprintOf(t, tsVersion("6.0.3")); other.Hash == base.Hash {
		t.Errorf("a different TypeScript 6 version gives the same fingerprint %s", base.Hash)
	}
	if none := fingerprintOf(t, resultsettest.ScoredProject()); none.Fields.TypeScript6Version != nil || none.Hash == base.Hash {
		t.Errorf("without a TypeScript 6 run: version %v, hash %s", none.Fields.TypeScript6Version, none.Hash)
	}
}
