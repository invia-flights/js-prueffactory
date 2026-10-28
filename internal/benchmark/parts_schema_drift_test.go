package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Schema drift part of the Validity area counts the committed files whose
// generator output differs, x50 = 2. Expected scores are worked out by hand
// from S = 100 * 2^(-x / x50).

func TestTheSchemaDriftPartCountsDriftedFiles(t *testing.T) {
	tests := []struct {
		name    string
		build   func(p *resultsettest.Project)
		wantRaw float64
		want    float64
	}{
		{"nothing differs", func(p *resultsettest.Project) { p.Applicable("schema.drift") }, 0, 100},
		{"one drifted file", func(p *resultsettest.Project) {
			p.Applicable("schema.drift")
			p.Add("schema.drift", "schema-drift.changed", false, resultsettest.AtPath("schemas/user.json"))
		}, 1, 70.7},
		{"two drifted files", func(p *resultsettest.Project) {
			p.Applicable("schema.drift")
			p.Add("schema.drift", "schema-drift.changed", false, resultsettest.AtPath("schemas/user.json"))
			p.Add("schema.drift", "schema-drift.changed", false, resultsettest.AtPath("schemas/order.json"))
		}, 2, 50},
		{"a created file and a failed generator do not count", func(p *resultsettest.Project) {
			p.Applicable("schema.drift")
			p.Add("schema.drift", "schema-drift.created", false, resultsettest.AtPath("schemas/index.json"))
			p.Add("schema.drift", "schema-drift.generator-failed", false, resultsettest.AtPath("package.json"))
		}, 0, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, "schema_drift")
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			if got.Label != "Schema drift" || got.X50 == nil || *got.X50 != 2 || got.RawUnit != "files" {
				t.Errorf("label %q, x50 %v, unit %q, want Schema drift, 2 and files", got.Label, got.X50, got.RawUnit)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestTheSchemaDriftPartIsDroppedWithoutAGeneratorScript(t *testing.T) {
	got := part(t, score(t, resultsettest.ScoredProject()).Benchmark, "schema_drift")
	if got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "schema.drift" {
		t.Errorf("sources = %v", got.SourceChecks)
	}
}

func TestAFailingGeneratorLeavesTheSchemaDriftPartUnknown(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Applicable("schema.drift")
	p.Add("schema.drift", "schema-drift.generator-failed", false, resultsettest.AtPath("package.json"))
	p.Status("schema.drift", resultset.StatusPartial, "generator_failed")

	got := part(t, score(t, p).Benchmark, "schema_drift")

	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "partial: generator_failed" {
		t.Errorf("state = %s, reason = %v, want unknown: partial: generator_failed", got.State, got.Reason)
	}
}
