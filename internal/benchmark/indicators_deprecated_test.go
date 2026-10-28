package benchmark_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

func TestDeprecatedDependenciesShowAsSideIndicatorsPerScopeAndNeverChangeTheScore(t *testing.T) {
	clean := score(t, resultsettest.ScoredProject()).Benchmark

	p := resultsettest.ScoredProject()
	p.AddExecution("deps.deprecated", "C-0002")
	for i := 0; i < 7; i++ {
		p.Add("deps.deprecated", "deprecated-version", false)
	}
	p.Metric("deps.deprecated", "deprecated_prod", 5, "versions")
	p.Metric("deps.deprecated", "deprecated_dev", 2, "versions")
	p.Metric("deps.deprecated", "registry_unknown", 30, "packages")
	b := score(t, p).Benchmark

	prod := indicator(t, b, "deprecated_prod")
	wantScore(t, "deprecated prod", prod.Value, 5)
	if prod.State != resultset.PartMeasured || prod.Unit != "versions" || len(prod.SourceChecks) != 1 || prod.SourceChecks[0] != "deps.deprecated" {
		t.Errorf("deprecated_prod = %+v", prod)
	}
	wantScore(t, "deprecated dev", indicator(t, b, "deprecated_dev").Value, 2)
	if *b.Score != *clean.Score || *b.Range != *clean.Range || *b.Verdict != *clean.Verdict {
		t.Errorf("deprecated dependencies changed the result: score %v and %v, range %+v and %+v",
			*clean.Score, *b.Score, *clean.Range, *b.Range)
	}
	for _, part := range b.Areas {
		for _, pt := range part.Parts {
			for _, src := range pt.SourceChecks {
				if src == "deps.deprecated" {
					t.Errorf("part %s is fed by deps.deprecated, which is a side indicator only", pt.ID)
				}
			}
		}
	}
}

func TestDeprecatedDependenciesAreUnknownNeverZeroWhenTheRegistryCouldNotBeReached(t *testing.T) {
	clean := score(t, resultsettest.ScoredProject()).Benchmark

	p := resultsettest.ScoredProject()
	p.AddExecution("deps.deprecated", "C-0002")
	p.Status("deps.deprecated", resultset.StatusBlocked, "registry_unreachable")
	b := score(t, p).Benchmark

	for _, id := range []string{"deprecated_prod", "deprecated_dev"} {
		got := indicator(t, b, id)
		if got.State != resultset.PartUnknown || got.Value != nil || got.Reason == nil || !strings.Contains(*got.Reason, "registry_unreachable") {
			t.Errorf("%s = %+v, want unknown without a value, naming registry_unreachable", id, got)
		}
	}
	if *b.Score != *clean.Score || *b.Verdict != *clean.Verdict {
		t.Errorf("an unreachable registry changed the score from %v to %v", *clean.Score, *b.Score)
	}
}

func TestDeprecatedIndicatorsAreUnknownWhenTheCheckDidNotTakePart(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	for _, id := range []string{"deprecated_prod", "deprecated_dev"} {
		if got := indicator(t, b, id); got.State != resultset.PartUnknown || got.Value != nil {
			t.Errorf("%s = %+v, want unknown without a value", id, got)
		}
	}
}
