package benchmark_test

import (
	"regexp"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

func fingerprintOf(t *testing.T, p *resultsettest.Project) resultset.BenchmarkFingerprint {
	t.Helper()
	fp := score(t, p).Benchmark.Fingerprint
	if fp == nil {
		t.Fatal("no fingerprint")
	}
	return *fp
}

func TestTheFingerprintHoldsEverythingThatShapesAScore(t *testing.T) {
	p := resultsettest.ScoredProject()
	toolDigest := "sha256:" + "cd"
	p.Set.Contexts[0].Tools = []resultset.ToolRef{{Name: "hadolint", Version: "2.12.0", Digest: &toolDigest}}
	svc := "sha256:" + "ef"
	p.Set.Services = []resultset.Service{{Family: "valkey", ComposeService: "cache", ImageDigest: &svc, DeclaredImage: "valkey/valkey:8", Status: resultset.ServiceStarted}}
	p.Set.Profiles.CatalogVersion = "milestone-1"
	p.Set.Profiles.ToolsetVersion = "toolset-abc"
	fp := fingerprintOf(t, p)

	f := fp.Fields
	if f.ProfileID != "benchmark-v1-uncalibrated" || f.CatalogVersion != "milestone-1" || f.ToolsetVersion != "toolset-abc" {
		t.Errorf("profile %q, catalog %q, toolset %q", f.ProfileID, f.CatalogVersion, f.ToolsetVersion)
	}
	wantDigests := []string{"sha256:" + resultsettest.SHA, "sha256:cd", "sha256:ef"}
	if len(f.ImageDigests) != 3 {
		t.Errorf("image digests = %v, want the Node image, the tool image and the Service image", f.ImageDigests)
	}
	for _, want := range wantDigests {
		found := false
		for _, got := range f.ImageDigests {
			found = found || got == want
		}
		if !found {
			t.Errorf("image digests %v lack %s", f.ImageDigests, want)
		}
	}
	if len(f.ESLintConfigHashes) != 1 || f.ESLintConfigHashes[0] != resultsettest.SHA {
		t.Errorf("eslint config hashes = %v, want the hash of the eslint-config tool", f.ESLintConfigHashes)
	}
	if len(f.SecurityRuleHashes) != 1 || f.SecurityRuleHashes[0] != "cd"+resultsettest.SHA[2:] {
		t.Errorf("security rule hashes = %v, want the hash of the tool-owned rules", f.SecurityRuleHashes)
	}
	if f.AdvisoryDatabaseDate == nil || *f.AdvisoryDatabaseDate != "2026-10-26T03:00:00Z" {
		t.Errorf("advisory database date = %v", f.AdvisoryDatabaseDate)
	}
	if len(f.Runtimes) != 1 || f.Runtimes[0].NodeVersion != "24.1.0" || f.Runtimes[0].NPMVersion != "11.1.0" {
		t.Errorf("runtimes = %+v, want Node 24.1.0 and npm 11.1.0", f.Runtimes)
	}
}

func TestTheShortHashChangesWithEveryFieldAndOnlyWithThem(t *testing.T) {
	base := fingerprintOf(t, resultsettest.ScoredProject())
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(base.Hash) {
		t.Errorf("hash = %q, want 12 hex digits", base.Hash)
	}
	if again := fingerprintOf(t, resultsettest.ScoredProject()); again.Hash != base.Hash {
		t.Errorf("the same Run twice gives %s and %s", base.Hash, again.Hash)
	}

	same := resultsettest.ScoredProject()
	same.Add("lint.correctness", "no-undef", false)
	same.Add("security.secrets", "generic-api-key", false)
	same.Set.Run.ID = "another-run"
	if got := fingerprintOf(t, same); got.Hash != base.Hash {
		t.Errorf("findings and run ID changed the fingerprint: %s and %s", base.Hash, got.Hash)
	}

	changes := map[string]func(p *resultsettest.Project){
		"toolset version": func(p *resultsettest.Project) { p.Set.Profiles.ToolsetVersion = "other" },
		"catalog version": func(p *resultsettest.Project) { p.Set.Profiles.CatalogVersion = "other" },
		"node version":    func(p *resultsettest.Project) { p.Set.Contexts[1].Node.Version = "22.5.0" },
		"node image":      func(p *resultsettest.Project) { p.Set.Contexts[1].Node.ImageDigest = "sha256:ff" },
		"npm version":     func(p *resultsettest.Project) { v := "10.0.0"; p.Set.Contexts[1].NPM = &v },
		"eslint config":   func(p *resultsettest.Project) { d := "00"; p.Set.Contexts[1].Tools[0].Digest = &d },
		"security rules":  func(p *resultsettest.Project) { d := "00"; p.Set.Contexts[1].Tools[2].Digest = &d },
		"advisory data":   func(p *resultsettest.Project) { p.Set.Contexts[1].Tools[1].Version = "2026-10-27T03:00:00Z" },
		"a service image": func(p *resultsettest.Project) {
			d := "sha256:aa"
			p.Set.Services = []resultset.Service{{Family: "valkey", ComposeService: "c", ImageDigest: &d, DeclaredImage: "v", Status: resultset.ServiceStarted}}
		},
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			change(p)
			if got := fingerprintOf(t, p); got.Hash == base.Hash {
				t.Errorf("a different %s gives the same fingerprint %s", name, got.Hash)
			}
		})
	}
}

func TestAContextWithoutASupportedNodeVersionAddsNoRuntime(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Set.Contexts[1].Node = nil
	p.Set.Contexts[1].NPM = nil
	fp := fingerprintOf(t, p)
	if len(fp.Fields.Runtimes) != 0 || len(fp.Fields.ImageDigests) != 0 {
		t.Errorf("runtimes %v, digests %v, want none", fp.Fields.Runtimes, fp.Fields.ImageDigests)
	}
}

func TestTwoContextsWithTheSameRuntimeAreOneRuntime(t *testing.T) {
	p := resultsettest.ScoredProject()
	other := p.Set.Contexts[1]
	other.ID = "C-0003"
	other.Path = "packages/b"
	p.Set.Contexts = append(p.Set.Contexts, other)
	if got := fingerprintOf(t, p); len(got.Fields.Runtimes) != 1 {
		t.Errorf("runtimes = %v, want one", got.Fields.Runtimes)
	}
}

func TestAnAdvisoryDatabaseThatWasNeverRecordedIsNull(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Set.Contexts[1].Tools = p.Set.Contexts[1].Tools[:1]
	if got := fingerprintOf(t, p); got.Fields.AdvisoryDatabaseDate != nil {
		t.Errorf("advisory database date = %v, want null", *got.Fields.AdvisoryDatabaseDate)
	}
}

func TestTheShippedCatalogVersionMakesEveryNewFingerprintDifferFromMilestoneOne(t *testing.T) {
	if checks.CatalogVersion != "milestone-2" {
		t.Fatalf("shipped Catalog version = %q, want milestone-2", checks.CatalogVersion)
	}
	withVersion := func(v string) resultset.BenchmarkFingerprint {
		p := resultsettest.ScoredProject()
		p.Set.Profiles.CatalogVersion = v
		return fingerprintOf(t, p)
	}
	now, before := withVersion(checks.CatalogVersion), withVersion("milestone-1")
	if now.Fields.CatalogVersion != "milestone-2" {
		t.Errorf("fingerprint catalog version = %q", now.Fields.CatalogVersion)
	}
	if now.Hash == before.Hash {
		t.Errorf("a milestone-1 Report and a milestone-2 Report share the fingerprint %s", now.Hash)
	}
}
