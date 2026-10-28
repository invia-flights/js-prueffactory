package checks

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestOnlyTheGroupsOfSelectedChecksAreSwitchedOn(t *testing.T) {
	proj, dir := eslintProblems(t)
	ctx := packageContext(t, proj, ".")

	all := &Input{Project: proj, Context: ctx, SnapshotDir: dir}
	var every []string
	for _, g := range all.eslintGroupsOn() {
		every = append(every, g.checkID)
	}
	if strings.Join(every, ",") != "deps.engines,lint.correctness,quality.metrics,tests.smells" {
		t.Errorf("without a Selection every registered group is on, in Check ID order: %v", every)
	}

	sel, err := Resolve(Catalog(), []string{"package.manifest"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	some := &Input{Project: proj, Context: ctx, SnapshotDir: dir, Selection: sel}
	if got := some.eslintGroupsOn(); len(got) != 0 {
		t.Errorf("lint.correctness is not selected, but its group is on: %+v", got)
	}

	sel, err = Resolve(Catalog(), []string{"lint.correctness"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	some.Selection = sel
	if got := some.eslintGroupsOn(); len(got) != 1 || got[0].checkID != "lint.correctness" {
		t.Errorf("groups = %+v, want lint.correctness", got)
	}

	sel, err = Resolve(Catalog(), []string{"tests.smells", "quality.metrics"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	some.Selection = sel
	var picked []string
	for _, g := range some.eslintGroupsOn() {
		picked = append(picked, g.checkID)
	}
	if strings.Join(picked, ",") != "quality.metrics,tests.smells" {
		t.Errorf("groups = %v, want only those of the selected Checks", picked)
	}
}

func TestChecksOfOnePackageShareOneESLintRunAndPackagesDoNot(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json":            `{"name":"a"}`,
		"a.js":                    "1;\n",
		"packages/b/package.json": `{"name":"b"}`,
		"packages/b/b.js":         "1;\n",
	})
	var calls atomic.Int32
	defer func(old func(context.Context, *Input, []eslintGroup) (*eslintRun, *Result)) { runESLintContainer = old }(runESLintContainer)
	runESLintContainer = func(context.Context, *Input, []eslintGroup) (*eslintRun, *Result) {
		calls.Add(1)
		return &eslintRun{ConfigSHA256: "x"}, nil
	}
	shared := NewShared()
	root := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir, Shared: shared}
	rootAgain := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir, Shared: shared}
	inner := &Input{Project: proj, Context: packageContext(t, proj, "packages/b"), SnapshotDir: dir, Shared: shared}

	first, _ := root.eslintRun(context.Background())
	second, _ := rootAgain.eslintRun(context.Background())
	inner.eslintRun(context.Background())

	if first != second {
		t.Error("two Checks of one package must read the same run")
	}
	if calls.Load() != 2 {
		t.Errorf("ESLint ran %d times, want once per package (2)", calls.Load())
	}
}

func TestAFailedRunEndsEveryCheckThatReadsItTheSameWayWithoutRunningAgain(t *testing.T) {
	proj, dir := eslintProblems(t)
	var calls atomic.Int32
	defer func(old func(context.Context, *Input, []eslintGroup) (*eslintRun, *Result)) { runESLintContainer = old }(runESLintContainer)
	runESLintContainer = func(context.Context, *Input, []eslintGroup) (*eslintRun, *Result) {
		calls.Add(1)
		return nil, &Result{Status: resultset.StatusToolError, ReasonCode: "helper_failed", Reason: "boom"}
	}
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir, Shared: NewShared()}

	a := lintCorrectness{}.Run(context.Background(), in)
	b := lintCorrectness{}.Run(context.Background(), in)

	if a.Status != resultset.StatusToolError || a.ReasonCode != "helper_failed" || b.ReasonCode != "helper_failed" {
		t.Errorf("results = %+v / %+v", a, b)
	}
	if calls.Load() != 1 {
		t.Errorf("ESLint ran %d times, want once", calls.Load())
	}
}

func TestWithoutAToolsetVolumeTheCheckEndsAsAnInfrastructureError(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir, ToolsetError: "no network"}

	res := lintCorrectness{}.Run(context.Background(), in)

	if res.Status != resultset.StatusInfrastructureError || res.ReasonCode != "toolset_unavailable" {
		t.Errorf("status = %s, %s", res.Status, res.ReasonCode)
	}
	if res.Reason == "" || !strings.Contains(res.Reason, "no network") {
		t.Errorf("reason = %q, want the toolset error in it", res.Reason)
	}
}

func TestTheCheckNamesTheImageItUsesAndTheToolset(t *testing.T) {
	proj, _ := eslintProblems(t)
	check := lintCorrectness{}
	if got := check.Images(packageContext(t, proj, ".")); len(got) != 1 || got[0] == "" {
		t.Errorf("images = %v, want the Node image", got)
	}
	if !check.UsesToolset(packageContext(t, proj, ".")) {
		t.Error("ESLint comes from the toolset volume")
	}
	if got := check.Images(&proj.Contexts[0]); len(got) != 0 {
		t.Errorf("the project Context starts no container: %v", got)
	}
}
