package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Expected values are worked out by hand: n_eff sums 1 + log2(count) over the
// rules, and S = 100 * 2^(-n_eff / x50) with x50 = 3.

func asNote(f *resultset.Finding) { f.Severity, f.Kind = resultset.SeverityNote, resultset.KindHint }

func TestTheGitHubActionsPartDampsFindingsAtWarningLevelOrAbove(t *testing.T) {
	const check = "repository.github-actions"
	tests := []struct {
		name     string
		build    func(p *resultsettest.Project)
		wantRaw  float64
		wantNEff float64
		want     float64
	}{
		{"clean workflows", func(p *resultsettest.Project) { p.Applicable(check) }, 0, 0, 100},
		{"a Gate and a warning of different rules", func(p *resultsettest.Project) {
			p.Applicable(check)
			p.Add(check, "actionlint.job-needs", true, resultsettest.AtPath(".github/workflows/ci.yml"))
			p.Add(check, "zizmor.template-injection", false, resultsettest.AtPath(".github/workflows/ci.yml"))
		}, 2, 2, 62.99605249474366},
		{"four warnings of one rule weigh 3", func(p *resultsettest.Project) {
			p.Applicable(check)
			for range 4 {
				p.Add(check, "zizmor.unpinned-uses", false, resultsettest.AtPath(".github/workflows/ci.yml"))
			}
		}, 4, 3, 50},
		{"notes do not count", func(p *resultsettest.Project) {
			p.Applicable(check)
			p.Add(check, "zizmor.excessive-permissions", false, resultsettest.AtPath(".github/workflows/ci.yml"), asNote)
			p.Add(check, "zizmor.template-injection", false, resultsettest.AtPath(".github/workflows/ci.yml"), asNote)
		}, 0, 0, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, "github_actions")
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			if got.Label != "GitHub Actions" || got.X50 == nil || *got.X50 != 3 || got.RawUnit != "hits" {
				t.Errorf("label %q, x50 %v, unit %q, want GitHub Actions, 3 and hits", got.Label, got.X50, got.RawUnit)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			wantScore(t, "n_eff", got.NEff, tc.wantNEff)
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestTheGitHubActionsPartIsDroppedWithoutWorkflows(t *testing.T) {
	got := part(t, score(t, resultsettest.ScoredProject()).Benchmark, "github_actions")
	if got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "repository.github-actions" {
		t.Errorf("sources = %v", got.SourceChecks)
	}
}
