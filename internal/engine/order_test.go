package engine

import (
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// Test suites take the longest, so they start as soon as their install is done:
// the installs they wait for go first, then the suites, then everything else.

func jobFor(check string, docker bool, needs ...*planned) (job, *planned) {
	p := &planned{entry: checks.Entry{ID: check}, needs: needs}
	return job{p: p, needsDocker: docker}, p
}

func idsOf(jobs []job) []string {
	var out []string
	for _, j := range jobs {
		out = append(out, j.p.entry.ID)
	}
	return out
}

func TestInstallsThatSuitesWaitForGoFirstThenTheSuitesThenTheRest(t *testing.T) {
	secrets, _ := jobFor("security.secrets", false)
	syntax, _ := jobFor("syntax.parse", true)
	install, installP := jobFor("package.install", true)
	tree, _ := jobFor("deps.tree", true, installP)
	suite, _ := jobFor("tests.existing", true, installP)
	lint, _ := jobFor("lint.existing", true)

	// Catalog order is how the planner lists them.
	jobs := []job{secrets, syntax, install, suite, lint, tree}
	orderJobs(jobs)

	want := []string{"security.secrets", "package.install", "tests.existing", "syntax.parse", "lint.existing", "deps.tree"}
	if got := idsOf(jobs); !slices.Equal(got, want) {
		t.Errorf("order = %v, want %v", got, want)
	}
}

func TestAnInstallNoSuiteWaitsForKeepsItsCatalogPlace(t *testing.T) {
	syntax, _ := jobFor("syntax.parse", true)
	install, _ := jobFor("package.install", true)
	lint, _ := jobFor("lint.existing", true)

	jobs := []job{syntax, install, lint}
	orderJobs(jobs)

	if got, want := idsOf(jobs), []string{"syntax.parse", "package.install", "lint.existing"}; !slices.Equal(got, want) {
		t.Errorf("order = %v, want %v", got, want)
	}
}
