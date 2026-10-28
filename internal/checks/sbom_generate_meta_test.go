package checks_test

import (
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const sbomID = "sbom.generate"

func TestSBOMGenerateIsAnImplementedPerPackageCheckWithoutGatesOrBenchmarkArea(t *testing.T) {
	e, ok := checks.Lookup(sbomID)
	if !ok || e.Status != checks.Implemented || e.Scope != checks.PerPackage || e.CanFireGates || e.Area != checks.AreaNone {
		t.Fatalf("entry = %+v, want an implemented per-package Check that fires no Gates and feeds no area", e)
	}
}

func TestSBOMGenerateRunsInTheNodeImageAndInstallsOnlyWithoutALockfile(t *testing.T) {
	_, c := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	impl := checks.Implementation(sbomID)

	if images := impl.(checks.ImageUser).Images(c); !slices.Equal(images, []string{c.Node.Image}) {
		t.Errorf("images = %v, want the package's Node image", images)
	}
	if got := impl.(checks.PrerequisiteUser).Prerequisites(c); len(got) != 0 {
		t.Errorf("prerequisites = %v: a package with a lockfile needs no install", got)
	}
	if a, reason := impl.Applicability(nil, c); a != resultset.Applicable || reason != "" {
		t.Errorf("applicability = %s %q", a, reason)
	}
	_, noLock := firstPackage(t, "../../testdata/projects/no-lockfile")
	if got := impl.(checks.PrerequisiteUser).Prerequisites(noLock); !slices.Equal(got, []string{"package.install"}) {
		t.Errorf("prerequisites = %v, want package.install for a package without lockfile", got)
	}
}

func TestSBOMGenerateHasNothingToExamineInTheProjectContext(t *testing.T) {
	proj, _ := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	project := proj.Contexts[0]

	if a, reason := checks.Implementation(sbomID).Applicability(proj, &project); a != resultset.NotApplicable || reason == "" {
		t.Errorf("applicability = %s %q, want not_applicable with a reason", a, reason)
	}
}
