package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

func TestTheKubernetesPartCountsInvalidResources(t *testing.T) {
	tests := []struct {
		name    string
		build   func(p *resultsettest.Project)
		wantRaw float64
		want    float64
	}{
		{"every resource is valid", func(p *resultsettest.Project) { p.Applicable("repository.kubernetes") }, 0, 100},
		{"one invalid resource", func(p *resultsettest.Project) {
			p.Applicable("repository.kubernetes")
			p.Add("repository.kubernetes", "kubernetes.invalid", true, resultsettest.AtPath("k8s/deploy.yaml"))
		}, 1, 50},
		{"two invalid resources in one file count twice", func(p *resultsettest.Project) {
			p.Applicable("repository.kubernetes")
			p.Add("repository.kubernetes", "kubernetes.invalid", true, resultsettest.AtPath("k8s/all.yaml"))
			p.Add("repository.kubernetes", "kubernetes.invalid", true, resultsettest.AtPath("k8s/all.yaml"))
		}, 2, 25},
		{"notes do not count", func(p *resultsettest.Project) {
			p.Applicable("repository.kubernetes")
			p.Add("repository.kubernetes", "kubernetes.error", false, resultsettest.AtPath("k8s/deploy.yaml"))
		}, 0, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, "kubernetes")
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			if got.Label != "Kubernetes" || got.X50 == nil || *got.X50 != 1 || got.RawUnit != "resources" {
				t.Errorf("label %q, x50 %v, unit %q, want Kubernetes, 1 and resources", got.Label, got.X50, got.RawUnit)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestTheKubernetesPartIsDroppedWithoutManifests(t *testing.T) {
	got := part(t, score(t, resultsettest.ScoredProject()).Benchmark, "kubernetes")
	if got.State != resultset.PartNotApplicable {
		t.Errorf("state = %s, want not_applicable", got.State)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "repository.kubernetes" {
		t.Errorf("sources = %v", got.SourceChecks)
	}
}

func TestTheKubernetesSchemaVersionIsPartOfTheFingerprint(t *testing.T) {
	hash := func(tool *resultset.ToolRef) (string, *string) {
		p := resultsettest.ScoredProject()
		if tool != nil {
			p.Set.Contexts[0].Tools = append(p.Set.Contexts[0].Tools, *tool)
		}
		f := score(t, p).Benchmark.Fingerprint
		return f.Hash, f.Fields.KubernetesSchemaVersion
	}
	none, noneField := hash(nil)
	ha, fa := hash(&resultset.ToolRef{Name: "kubernetes-schemas", Version: "1.34.1"})
	hb, fb := hash(&resultset.ToolRef{Name: "kubernetes-schemas", Version: "1.35.0"})
	if noneField != nil || fa == nil || *fa != "1.34.1" || fb == nil || *fb != "1.35.0" {
		t.Errorf("fields = %v, %v, %v", noneField, fa, fb)
	}
	if none == ha || ha == hb || none == hb {
		t.Errorf("the Kubernetes version should change the fingerprint hash: %s %s %s", none, ha, hb)
	}
}
