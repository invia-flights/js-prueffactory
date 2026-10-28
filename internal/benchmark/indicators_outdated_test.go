package benchmark_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

func TestOutdatedDependenciesShowAsSideIndicatorsAndNeverChangeTheScore(t *testing.T) {
	clean := score(t, resultsettest.ScoredProject()).Benchmark

	p := resultsettest.ScoredProject()
	p.AddExecution("deps.outdated", "C-0002")
	for i := 0; i < 4; i++ {
		p.Add("deps.outdated", "major-version-behind", false)
	}
	p.Metric("deps.outdated", "libyears_total", 41.5, "years")
	p.Metric("deps.outdated", "majors_behind", 4, "dependencies")
	p.Metric("deps.outdated", "registry_unknown", 2, "packages")
	b := score(t, p).Benchmark

	years := indicator(t, b, "libyears_total")
	wantScore(t, "libyears", years.Value, 41.5)
	if years.State != resultset.PartMeasured || years.Unit != "years" || len(years.SourceChecks) != 1 || years.SourceChecks[0] != "deps.outdated" {
		t.Errorf("libyears_total = %+v", years)
	}
	majors := indicator(t, b, "majors_behind")
	wantScore(t, "majors behind", majors.Value, 4)
	if majors.Unit != "dependencies" {
		t.Errorf("majors_behind = %+v", majors)
	}
	if *b.Score != *clean.Score || *b.Range != *clean.Range || *b.Verdict != *clean.Verdict {
		t.Errorf("outdated dependencies changed the result: score %v and %v, range %+v and %+v",
			*clean.Score, *b.Score, *clean.Range, *b.Range)
	}
	for _, area := range b.Areas {
		for _, pt := range area.Parts {
			for _, src := range pt.SourceChecks {
				if src == "deps.outdated" {
					t.Errorf("part %s is fed by deps.outdated, which is a side indicator only", pt.ID)
				}
			}
		}
	}
}

func TestOutdatedIndicatorsAreUnknownNeverZeroWhenTheRegistryCouldNotBeReached(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.AddExecution("deps.outdated", "C-0002")
	p.Status("deps.outdated", resultset.StatusBlocked, "registry_unreachable")
	b := score(t, p).Benchmark

	for _, id := range []string{"libyears_total", "majors_behind"} {
		got := indicator(t, b, id)
		if got.State != resultset.PartUnknown || got.Value != nil || got.Reason == nil || !strings.Contains(*got.Reason, "registry_unreachable") {
			t.Errorf("%s = %+v, want unknown without a value, naming registry_unreachable", id, got)
		}
	}
}

func TestOutdatedIndicatorsAreUnknownWhenTheCheckDidNotTakePart(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	for _, id := range []string{"libyears_total", "majors_behind"} {
		if got := indicator(t, b, id); got.State != resultset.PartUnknown || got.Value != nil {
			t.Errorf("%s = %+v, want unknown without a value", id, got)
		}
	}
}
