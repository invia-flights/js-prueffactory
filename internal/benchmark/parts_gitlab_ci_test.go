package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

func TestTheGitLabCIPartCountsInvalidFilesAndBrokenReferences(t *testing.T) {
	tests := []struct {
		name    string
		build   func(p *resultsettest.Project)
		wantRaw float64
		want    float64
	}{
		{"a valid pipeline", func(p *resultsettest.Project) { p.Applicable("repository.gitlab-ci") }, 0, 100},
		{"two schema errors in one file are one invalid file", func(p *resultsettest.Project) {
			p.Applicable("repository.gitlab-ci")
			p.Add("repository.gitlab-ci", "gitlab-ci.schema", true, resultsettest.AtPath("ci/deploy.yml"))
			p.Add("repository.gitlab-ci", "gitlab-ci.schema", true, resultsettest.AtPath("ci/deploy.yml"))
		}, 1, 50},
		{"an invalid file plus two broken references", func(p *resultsettest.Project) {
			p.Applicable("repository.gitlab-ci")
			p.Add("repository.gitlab-ci", "gitlab-ci.schema", true, resultsettest.AtPath("ci/deploy.yml"))
			p.Add("repository.gitlab-ci", "gitlab-ci.unknown-job", true, resultsettest.AtPath(".gitlab-ci.yml"))
			p.Add("repository.gitlab-ci", "gitlab-ci.unknown-job", true, resultsettest.AtPath(".gitlab-ci.yml"))
		}, 3, 12.5},
		{"a missing local include and an undeclared stage", func(p *resultsettest.Project) {
			p.Applicable("repository.gitlab-ci")
			p.Add("repository.gitlab-ci", "gitlab-ci.include-missing", true, resultsettest.AtPath(".gitlab-ci.yml"))
			p.Add("repository.gitlab-ci", "gitlab-ci.unknown-stage", true, resultsettest.AtPath(".gitlab-ci.yml"))
		}, 2, 25},
		{"notes do not count", func(p *resultsettest.Project) {
			p.Applicable("repository.gitlab-ci")
			p.Add("repository.gitlab-ci", "gitlab-ci.schema", false, resultsettest.AtPath(".gitlab-ci.yml"))
			p.Add("repository.gitlab-ci", "gitlab-ci.unknown-job", false, resultsettest.AtPath(".gitlab-ci.yml"))
		}, 0, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, "gitlab_ci")
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			if got.X50 == nil || *got.X50 != 1 || got.RawUnit != "problems" {
				t.Errorf("x50 %v, unit %q, want 1 and problems", got.X50, got.RawUnit)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestTheGitLabCIPartIsDroppedWithoutAPipelineFile(t *testing.T) {
	got := part(t, score(t, resultsettest.ScoredProject()).Benchmark, "gitlab_ci")
	if got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "repository.gitlab-ci" {
		t.Errorf("sources = %v", got.SourceChecks)
	}
}

func TestTheGitLabCISchemaHashIsPartOfTheFingerprint(t *testing.T) {
	hash := func(tool *resultset.ToolRef) (string, *string) {
		p := resultsettest.ScoredProject()
		if tool != nil {
			p.Set.Contexts[0].Tools = append(p.Set.Contexts[0].Tools, *tool)
		}
		f := score(t, p).Benchmark.Fingerprint
		return f.Hash, f.Fields.GitLabCISchemaHash
	}
	a, b := "aaaa", "bbbb"
	none, noneField := hash(nil)
	ha, fa := hash(&resultset.ToolRef{Name: "gitlab-ci-schema", Version: "18.5.0-aaaa", Digest: &a})
	hb, fb := hash(&resultset.ToolRef{Name: "gitlab-ci-schema", Version: "18.5.0-bbbb", Digest: &b})
	if noneField != nil || fa == nil || *fa != a || fb == nil || *fb != b {
		t.Errorf("fields = %v, %v, %v", noneField, fa, fb)
	}
	if none == ha || ha == hb || none == hb {
		t.Errorf("the schema hash should change the fingerprint hash: %s %s %s", none, ha, hb)
	}
}
