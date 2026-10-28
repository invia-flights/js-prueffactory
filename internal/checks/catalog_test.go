package checks_test

import (
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// milestone1 is the order in which milestone 1 shipped its 29 Checks.
var milestone1 = []string{
	"package.manifest", "artifacts.structured", "syntax.parse", "security.secrets",
	"security.dependencies", "package.install", "tests.existing", "lint.existing",
	"lint.correctness", "tests.coverage", "tests.smells", "runtime.warnings",
	"types.javascript", "quality.unused", "modules.cycles", "quality.clones",
	"quality.metrics", "quality.size", "quality.suppressions", "security.integrity",
	"security.licenses", "package.install-scripts", "deps.tree", "deps.engines",
	"repository.dockerfile", "repository.shell", "repository.helm", "api.lint",
	"schema.compile",
}

func TestCatalogListsAllMilestoneOneChecks(t *testing.T) {
	if len(milestone1) != 29 {
		t.Fatalf("test list has %d entries, the milestone-1 Catalog has 29", len(milestone1))
	}
	byID := map[string]checks.Entry{}
	for _, e := range checks.Catalog() {
		byID[e.ID] = e
	}
	for _, id := range milestone1 {
		e, ok := byID[id]
		if !ok {
			t.Errorf("%s is missing from the Catalog", id)
			continue
		}
		if e.Family == "" || e.Family != id[:len(e.Family)] || id[len(e.Family)] != '.' {
			t.Errorf("%s: family %q is not the part before the first dot", id, e.Family)
		}
		if e.Area == "" {
			t.Errorf("%s has no Benchmark area", id)
		}
	}
}

// A Check is implemented exactly when an implementation registered itself. The
// test names no planned Check, so Check tickets only change what is registered.
func TestACheckIsImplementedExactlyWhenItIsRegistered(t *testing.T) {
	var implemented []string
	for _, e := range checks.Catalog() {
		if got := e.Status == checks.Implemented; got != (checks.Implementation(e.ID) != nil) {
			t.Errorf("%s: status %s, implementation registered: %v", e.ID, e.Status, !got)
		}
		if e.Status == checks.Implemented {
			implemented = append(implemented, e.ID)
		}
	}
	if !slices.Contains(implemented, "syntax.parse") {
		t.Errorf("implemented = %v, want syntax.parse among them", implemented)
	}
	if !slices.Equal(implemented, checks.ImplementedIDs()) {
		t.Errorf("ImplementedIDs = %v, the Catalog says %v", checks.ImplementedIDs(), implemented)
	}
}

func TestTheShippedProfilesAreTheMilestoneTwoOnes(t *testing.T) {
	if checks.CatalogVersion != "milestone-2" || checks.ExecutionProfile != "execution-v1" {
		t.Errorf("Catalog version %q, execution profile %q", checks.CatalogVersion, checks.ExecutionProfile)
	}
}

func TestCatalogIDsAreUniqueAndKeepTheirOrder(t *testing.T) {
	seen := map[string]bool{}
	var order []string
	for _, e := range checks.Catalog() {
		if seen[e.ID] {
			t.Errorf("duplicate Check %s", e.ID)
		}
		seen[e.ID] = true
		order = append(order, e.ID)
	}
	// The milestone-1 Checks come first, in the order milestone 1 shipped them.
	if !slices.Equal(order[:len(milestone1)], milestone1) {
		t.Errorf("Catalog order changed:\n%v", order[:len(milestone1)])
	}
}

func TestSyntaxParseMetadata(t *testing.T) {
	e, ok := checks.Lookup("syntax.parse")
	if !ok {
		t.Fatal("syntax.parse not found")
	}
	if !e.CanFireGates || e.Area != "validity" || e.Scope != checks.PerPackage {
		t.Errorf("syntax.parse = %+v", e)
	}
	if checks.Implementation("syntax.parse") == nil {
		t.Error("syntax.parse has no implementation")
	}
}

func TestSecurityPatternsFeedsTheSecurityArea(t *testing.T) {
	e, ok := checks.Lookup("security.patterns")
	if !ok || e.Area != checks.AreaSecurity {
		t.Fatalf("security.patterns = %+v, want the area %q", e, checks.AreaSecurity)
	}
}

func TestTestsExistingIsImplementedAndNeedsThePackagesInstall(t *testing.T) {
	e, ok := checks.Lookup("tests.existing")
	if !ok || e.Status != checks.Implemented || !e.CanFireGates || e.Area != "tests" || e.Scope != checks.PerPackage {
		t.Fatalf("tests.existing = %+v, want an implemented per-package Check that can fire Gates", e)
	}
	impl := checks.Implementation("tests.existing")
	if _, ok := impl.(checks.PrerequisiteUser); !ok {
		t.Error("tests.existing runs after package.install, so it implements PrerequisiteUser")
	}
	if _, ok := impl.(checks.ImageUser); !ok {
		t.Error("tests.existing runs a container, so it implements ImageUser")
	}
	if u, ok := impl.(checks.WorkingCopyUser); !ok || !u.UsesWorkingCopy() {
		t.Error("tests.existing runs in the Working copy")
	}
}
