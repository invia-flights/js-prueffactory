package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Seam B: what the Benchmark makes of a lint.existing that is not applicable to
// a package, such as one with ESLint as a dependency and no configuration.

func TestAProjectLinterThatDoesNotApplyToOnePackageIsMeasuredFromThePackagesWhereItDoes(t *testing.T) {
	// One package has ESLint without any configuration, so lint.existing is not
	// applicable there; a second package has Biome, which runs with defaults.
	p := resultsettest.ScoredProject()
	p.Set.Contexts = append(p.Set.Contexts, resultset.Context{ID: "C-0003", Kind: "package", Path: "packages/biome"})
	p.AddExecution("lint.existing", "C-0003")
	p.Add("lint.existing", "lint/suspicious/noDebugger", true, func(f *resultset.Finding) {
		f.ExecutionID, f.ContextID = "added-lint.existing", "C-0003"
	})

	got := part(t, score(t, p).Benchmark, "project_linter")

	if got.State != resultset.PartMeasured {
		t.Fatalf("state = %s (%v), want measured from the package where the Check applies", got.State, got.Reason)
	}
	wantScore(t, "raw value", got.RawValue, 1)
}

func TestAProjectLinterThatAppliesToNoPackageIsNotApplicableAndKeepsTheAreasOtherParts(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.NotApplicable("lint.existing")

	b := score(t, p).Benchmark

	got := part(t, b, "project_linter")
	if got.State != resultset.PartNotApplicable {
		t.Fatalf("state = %s, want not_applicable", got.State)
	}
	wantNull(t, "part score", got.Score)
	if a := area(t, b, "code_correctness"); !a.Exists || !a.FullyMeasured {
		t.Errorf("code correctness exists %v, fully measured %v, want the area kept with its other parts", a.Exists, a.FullyMeasured)
	}
}
