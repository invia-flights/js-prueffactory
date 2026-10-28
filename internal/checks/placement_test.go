package checks_test

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// fakeCheck answers Applicability from a table keyed by Context ID.
type fakeCheck map[string]resultset.Applicability

func (f fakeCheck) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if a, ok := f[c.ID]; ok {
		return a, "reason for " + c.ID
	}
	return resultset.Applicable, ""
}

func (fakeCheck) Run(context.Context, *checks.Input) *checks.Result { return nil }

func twoPackageProject() *discovery.Project {
	pkg := func(path, id string) discovery.Context {
		return discovery.Context{
			Package: &discovery.Package{Path: path, ContextID: id},
			Context: resultset.Context{ID: id, Kind: "package", Path: path},
		}
	}
	return &discovery.Project{Contexts: []discovery.Context{
		{Context: resultset.Context{ID: "C-0001", Kind: "project", Path: "."}},
		pkg(".", "C-0002"), pkg("tools", "C-0003"),
	}}
}

func TestPerPackageChecksGetOnePlacementPerPackageAndKeepUnknownApplicability(t *testing.T) {
	impl := fakeCheck{"C-0003": resultset.Unknown}
	got := checks.Placements(twoPackageProject(), checks.Entry{ID: "tests.existing", Scope: checks.PerPackage}, impl)
	if len(got) != 2 {
		t.Fatalf("placements = %+v", got)
	}
	if got[0].Context.ID != "C-0002" || got[0].Applicability != resultset.Applicable {
		t.Errorf("first = %+v", got[0])
	}
	if got[1].Context.ID != "C-0003" || got[1].Applicability != resultset.Unknown || got[1].Reason != "reason for C-0003" {
		t.Errorf("second = %+v", got[1])
	}
}

func TestPerProjectChecksGetOnePlacementInTheProjectContext(t *testing.T) {
	got := checks.Placements(twoPackageProject(), checks.Entry{ID: "quality.size", Scope: checks.PerProject}, fakeCheck{})
	if len(got) != 1 || got[0].Context.ID != "C-0001" {
		t.Fatalf("placements = %+v", got)
	}
}

func TestPerPackageCheckInAProjectWithoutPackagesIsNotApplicableInTheProjectContext(t *testing.T) {
	proj := &discovery.Project{Contexts: []discovery.Context{
		{Context: resultset.Context{ID: "C-0001", Kind: "project", Path: "."}},
	}}
	got := checks.Placements(proj, checks.Entry{ID: "syntax.parse", Scope: checks.PerPackage}, fakeCheck{})
	if len(got) != 1 || got[0].Context.ID != "C-0001" || got[0].Applicability != resultset.NotApplicable || got[0].Reason == "" {
		t.Fatalf("placements = %+v", got)
	}
}
