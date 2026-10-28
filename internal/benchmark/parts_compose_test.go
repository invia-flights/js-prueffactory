package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

func TestTheComposePartCountsInvalidSets(t *testing.T) {
	tests := []struct {
		name    string
		build   func(p *resultsettest.Project)
		wantRaw float64
		want    float64
	}{
		{"every set is valid", func(p *resultsettest.Project) { p.Applicable("repository.compose") }, 0, 100},
		{"one invalid set", func(p *resultsettest.Project) {
			p.Applicable("repository.compose")
			p.Add("repository.compose", "compose.invalid", true, resultsettest.AtPath("compose.yaml"))
		}, 1, 50},
		{"two invalid sets", func(p *resultsettest.Project) {
			p.Applicable("repository.compose")
			p.Add("repository.compose", "compose.invalid", true, resultsettest.AtPath("compose.yaml"))
			p.Add("repository.compose", "compose.invalid", true, resultsettest.AtPath("compose.prod.yaml"))
		}, 2, 25},
		{"a missing variable is a warning and does not count", func(p *resultsettest.Project) {
			p.Applicable("repository.compose")
			p.Add("repository.compose", "compose.variable-missing", false, resultsettest.AtPath("compose.yaml"))
		}, 0, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, "compose")
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			if got.Label != "Compose" || got.X50 == nil || *got.X50 != 1 || got.RawUnit != "sets" {
				t.Errorf("label %q, x50 %v, unit %q, want Compose, 1 and sets", got.Label, got.X50, got.RawUnit)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestTheComposePartIsDroppedWithoutComposeFiles(t *testing.T) {
	got := part(t, score(t, resultsettest.ScoredProject()).Benchmark, "compose")
	if got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "repository.compose" {
		t.Errorf("sources = %v", got.SourceChecks)
	}
}
