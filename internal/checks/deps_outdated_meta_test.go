package checks_test

import (
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const outdatedID = "deps.outdated"

func TestDepsOutdatedIsAnImplementedSideIndicatorWithoutGates(t *testing.T) {
	e, ok := checks.Lookup(outdatedID)
	if !ok || e.Status != checks.Implemented || e.Scope != checks.PerPackage || e.CanFireGates || e.Area != checks.AreaSideIndicator {
		t.Fatalf("entry = %+v, want an implemented per-package side indicator that fires no Gates", e)
	}
}

func TestDepsOutdatedSharesTheRegistryStepOfDepsDeprecated(t *testing.T) {
	_, c := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	impl := checks.Implementation(outdatedID)

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

func TestDepsOutdatedHasNothingToExamineInTheProjectContext(t *testing.T) {
	proj, _ := firstPackage(t, "../../testdata/projects/vulnerable-dependency")
	project := proj.Contexts[0]

	if a, reason := checks.Implementation(outdatedID).Applicability(proj, &project); a != resultset.NotApplicable || reason == "" {
		t.Errorf("applicability = %s %q, want not_applicable with a reason", a, reason)
	}
}
