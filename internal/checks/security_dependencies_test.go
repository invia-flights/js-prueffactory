package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

const depsID = "security.dependencies"

// firstPackage discovers the project in dir and returns it with its first
// package Context.
func firstPackage(t *testing.T, dir string) (*discovery.Project, *discovery.Context) {
	t.Helper()
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := proj.Contexts[1]
	return proj, &c
}

func TestSecurityDependenciesIsImplementedAndPerPackageWithoutGates(t *testing.T) {
	e, ok := checks.Lookup(depsID)
	if !ok || e.Status != checks.Implemented || e.Scope != checks.PerPackage || e.CanFireGates || e.Area != checks.AreaSecurity {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSecurityDependenciesPullsTheOSVScannerImageAndNeedsTheDatabase(t *testing.T) {
	_, c := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	impl := checks.Implementation(depsID)
	if got := impl.(checks.ImageUser).Images(c); !slices.Equal(got, []string{toolset.OSVScanner.Image.Ref()}) {
		t.Errorf("images = %v, want the pinned osv-scanner image only", got)
	}
	if !impl.(checks.AdvisoryDBUser).UsesAdvisoryDB(c) {
		t.Error("the Check scans with the advisory database")
	}
	if got := impl.(checks.PrerequisiteUser).Prerequisites(c); len(got) != 0 {
		t.Errorf("prerequisites = %v: a package with a lockfile needs no install", got)
	}
}

func TestAPackageWithoutALockfileIsScannedWithTheLockfileItsInstallProduced(t *testing.T) {
	_, c := firstPackage(t, "../../testdata/projects/no-lockfile")
	impl := checks.Implementation(depsID)
	if got := impl.(checks.PrerequisiteUser).Prerequisites(c); !slices.Equal(got, []string{"package.install"}) {
		t.Errorf("prerequisites = %v, want package.install", got)
	}
	applicability, reason := impl.Applicability(nil, c)
	if applicability != resultset.Applicable || reason != "" {
		t.Errorf("applicability = %v (%q), want applicable", applicability, reason)
	}
}

func TestTheProjectContextHasNothingToScan(t *testing.T) {
	proj, _ := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	a, _ := checks.Implementation(depsID).Applicability(proj, &proj.Contexts[0])
	if a != resultset.NotApplicable {
		t.Errorf("applicability in the project Context = %v", a)
	}
}

func TestAnUnusableLockfileIsUnsupportedNotClean(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{"name":"x","version":"1.0.0"}`)
	write("package-lock.json", `{"lockfileVersion": 1, "dependencies": {}}`)
	proj, c := firstPackage(t, dir)
	res := checks.Implementation(depsID).Run(context.Background(), &checks.Input{
		Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir,
		AdvisoryVolume: "jspf-cache-osv-db", AdvisoryDate: time.Now(),
	})
	if res.Status != resultset.StatusUnsupported || res.ReasonCode != "lockfile_version_unsupported" || len(res.Findings) != 0 {
		t.Fatalf("result = %+v", res)
	}
}

func TestWithoutAnAdvisoryDatabaseTheCheckEndsAsInfrastructureErrorNotClean(t *testing.T) {
	dir := "../../testdata/projects/vulnerable-dependency"
	proj, c := firstPackage(t, dir)
	res := checks.Implementation(depsID).Run(context.Background(), &checks.Input{
		Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir,
		AdvisoryError: "the advisory database could not be downloaded: no route to host",
	})
	if res.Status != resultset.StatusInfrastructureError || res.ReasonCode != "advisory_database_unavailable" ||
		!strings.Contains(res.Reason, "no route to host") || len(res.Findings) != 0 {
		t.Fatalf("result = %+v", res)
	}
}
