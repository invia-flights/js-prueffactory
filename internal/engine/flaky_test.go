package engine

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

// tests.flaky repeats the suites after the shared first run. It is scheduled
// right after tests.existing, ahead of the static Checks, and each of its repeat
// runs has the suite time limit inside the Budget.

func planProjectWithTests(t *testing.T, only ...string) []*planned {
	t.Helper()
	root := t.TempDir()
	for name, body := range map[string]string{
		"package.json":      `{"name":"demo","scripts":{"test":"mocha"},"devDependencies":{"mocha":"^10.0.0"}}`,
		"test/a.test.js":    "it('x', () => {})\n",
		"package-lock.json": "{}",
	} {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	sel, err := checks.ResolveCatalog(only, nil)
	if err != nil {
		t.Fatal(err)
	}
	return plan(proj, sel)
}

func plannedOf(t *testing.T, all []*planned, check string) *planned {
	t.Helper()
	for _, p := range all {
		if p.entry.ID == check && p.context.Package != nil {
			return p
		}
	}
	t.Fatalf("%s is not planned", check)
	return nil
}

func TestFlakyFollowsTestsExistingOfItsPackage(t *testing.T) {
	all := planProjectWithTests(t)
	flaky, existing := plannedOf(t, all, "tests.flaky"), plannedOf(t, all, "tests.existing")

	if !slices.Contains(flaky.follows, existing) {
		t.Errorf("tests.flaky follows %v, want tests.existing of its package", flaky.follows)
	}
	if len(flaky.needs) != 1 || flaky.needs[0].entry.ID != "package.install" {
		t.Errorf("tests.flaky needs %v, want the install only: a failing suite is what it is for", flaky.needs)
	}
}

func TestTheFirstRunHappensEvenWhenTestsExistingIsNotSelected(t *testing.T) {
	all := planProjectWithTests(t, "tests.flaky")
	existing := plannedOf(t, all, "tests.existing")

	if !existing.deselected || !existing.prerequisite || !existing.runnable() {
		t.Errorf("tests.existing: deselected %v, prerequisite %v, runnable %v; it must run, and be reported as not selected",
			existing.deselected, existing.prerequisite, existing.runnable())
	}
}

func TestTheSchedulerStartsFlakyOnlyAfterTestsExistingFinished(t *testing.T) {
	all := planProjectWithTests(t)
	flaky, existing := plannedOf(t, all, "tests.flaky"), plannedOf(t, all, "tests.existing")
	jobs := []job{{index: 0, p: flaky}, {index: 1, p: existing}}

	linkAfter(jobs)

	if !slices.Contains(jobs[0].after, 1) {
		t.Errorf("tests.flaky waits for %v, want the position of tests.existing (1), wherever it is in the list", jobs[0].after)
	}
	if slices.Contains(jobs[1].after, 0) {
		t.Errorf("tests.existing waits for %v: it must not wait for tests.flaky", jobs[1].after)
	}
}

func TestFlakyRunsWithTheSuitesAheadOfStaticChecksAndHasNoTimeLimitOfItsOwnBeyondTheBudget(t *testing.T) {
	if !isTestSuite("tests.flaky") {
		t.Error("the repeat runs take as long as the suites, so they are scheduled with them")
	}
	if got := timeLimit("tests.flaky"); got < 6*testSuiteTimeout {
		t.Errorf("timeLimit = %s: every repeat run has the suite limit of %s, so the execution must not cut them short", got, testSuiteTimeout)
	}
	if testSuiteTimeout != 30*time.Minute {
		t.Errorf("suite time limit = %s, want 30 minutes", testSuiteTimeout)
	}

	syntax, _ := jobFor("syntax.parse", true)
	install, installP := jobFor("package.install", true)
	suite, _ := jobFor("tests.existing", true, installP)
	flaky, _ := jobFor("tests.flaky", true, installP)
	lint, _ := jobFor("lint.existing", true)
	jobs := []job{syntax, install, suite, lint, flaky}
	orderJobs(jobs)
	want := []string{"package.install", "tests.existing", "tests.flaky", "syntax.parse", "lint.existing"}
	if got := idsOf(jobs); !slices.Equal(got, want) {
		t.Errorf("order = %v, want %v", got, want)
	}
}

// A Check that watches its own limits keeps its partial status when the Budget
// ends, where the engine would otherwise report the execution as
// budget_exhausted. A cancellation by the user always shows as cancelled.

type limitWatcher struct{ keeps bool }

func (limitWatcher) Applicability(*discovery.Project, *discovery.Context) (resultset.Applicability, string) {
	return resultset.Applicable, ""
}

func (l limitWatcher) Run(context.Context, *checks.Input) *checks.Result {
	return &checks.Result{Status: resultset.StatusPartial, ReasonCode: "budget_exhausted", Reason: "the Budget ran out during run 3",
		KeepsStatus: l.keeps, Findings: []resultset.Finding{{Title: "kept"}}}
}

func executeAfterBudget(t *testing.T, keeps bool, runCtx context.Context) *execResult {
	t.Helper()
	r := &run{log: progress.New(io.Discard, nil), snap: &snapshot.Snapshot{Dir: t.TempDir()}, proj: &discovery.Project{}}
	p := &planned{
		key: "x9", entry: checks.Entry{ID: "tests.flaky", Family: "tests"}, check: limitWatcher{keeps},
		context:       &discovery.Context{Context: resultset.Context{ID: "C-0002"}},
		applicability: resultset.Applicable,
	}
	budget, cancel := context.WithDeadline(runCtx, time.Now().Add(-time.Second))
	defer cancel()
	return r.execute(runCtx, budget, p, false)
}

func TestACheckThatWatchesItsOwnLimitsKeepsItsPartialStatusWhenTheBudgetEnds(t *testing.T) {
	res := executeAfterBudget(t, true, context.Background())
	if res.exec.Status != resultset.StatusPartial || deref(res.exec.ReasonCode) != "budget_exhausted" || len(res.findings) != 1 {
		t.Errorf("status = %s (%s), findings = %d", res.exec.Status, deref(res.exec.ReasonCode), len(res.findings))
	}
}

func TestOtherChecksThatEndWithTheBudgetAreStillReportedAsBudgetExhausted(t *testing.T) {
	res := executeAfterBudget(t, false, context.Background())
	if res.exec.Status != resultset.StatusBudgetExhausted || len(res.findings) != 1 {
		t.Errorf("status = %s, findings = %d: the Findings stay, the status says why it ended", res.exec.Status, len(res.findings))
	}
}

func TestACancelledRunIsReportedAsCancelledEvenForACheckThatKeepsItsStatus(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if res := executeAfterBudget(t, true, ctx); res.exec.Status != resultset.StatusCancelled {
		t.Errorf("status = %s, want cancelled", res.exec.Status)
	}
}
