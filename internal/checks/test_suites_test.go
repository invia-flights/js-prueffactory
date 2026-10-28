package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A package's tests are a list of suites. Discovery gives every package one
// suite today; these tests give the Checks a package with two, so that the
// loop over the list is held to its contract before anything produces one.

// twoSuiteInput is a package with a Mocha suite and a node:test suite.
func twoSuiteInput(t *testing.T) *Input {
	t.Helper()
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	in.Context.Package.Tests = &discovery.TestSetup{Suites: []discovery.Suite{
		{Runner: discovery.RunnerMocha, Args: []string{"test/unit"}, Origin: "test:unit"},
		{Runner: discovery.RunnerNodeTest, Args: []string{"--test", "test/api"}, Origin: "test:api"},
	}}
	return in
}

// stubSuites replaces the run of one suite with a function of the suite the Input
// is bound to, and records which suites ran, in order.
func stubSuites(t *testing.T, run func(in *Input, ran int) *Result) *[]string {
	t.Helper()
	var order []string
	old := runTestSuite
	t.Cleanup(func() { runTestSuite = old })
	runTestSuite = func(_ context.Context, in *Input) *Result {
		order = append(order, string(in.suite().Runner))
		return run(in, len(order)-1)
	}
	return &order
}

func TestEverySuiteOfAPackageRunsOnceInListOrder(t *testing.T) {
	in := twoSuiteInput(t)
	order := stubSuites(t, func(in *Input, _ int) *Result {
		return finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
	})

	testsExisting{}.Run(context.Background(), in)
	Implementation(runtimeWarningsID).Run(context.Background(), in)

	if got := strings.Join(*order, ","); got != "mocha,node:test" {
		t.Errorf("suites ran as %q, want mocha,node:test once each", got)
	}
}

func TestEachSuiteGetsContainerNamesOfItsOwn(t *testing.T) {
	in := twoSuiteInput(t)
	first, second := in.forSuite(0).suiteSuffix(), in.forSuite(1).suiteSuffix()
	if first != strings.ToLower(in.Context.ID) {
		t.Errorf("the first suite keeps the names a package with one suite has: %q", first)
	}
	if second == first || !strings.HasPrefix(second, first) {
		t.Errorf("suffixes %q and %q must differ", first, second)
	}
}

func TestSuitesThatFailDoNotStopTheOnesAfterThem(t *testing.T) {
	in := twoSuiteInput(t)
	order := stubSuites(t, func(in *Input, ran int) *Result {
		if ran == 0 {
			return &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{{Gate: true}}}
		}
		return finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
	})

	testsExisting{}.Run(context.Background(), in)

	if len(*order) != 2 {
		t.Errorf("suites ran: %v", *order)
	}
}

func TestTestsExistingAddsUpTheSuitesOfAPackage(t *testing.T) {
	in := twoSuiteInput(t)
	id := in.Context.ID
	stubSuites(t, func(_ *Input, ran int) *Result {
		if ran == 0 {
			return &Result{
				Status:    resultset.StatusCompleted,
				Findings:  []resultset.Finding{{Title: "first suite finding"}},
				TestCases: []SuiteTestCase{{Findings: []int{0}}},
				Inventory: &resultset.Inventory{
					Tests:     []resultset.PackageTests{{ContextID: id, Found: 2, Run: 2, Passed: 1, Failed: 1}},
					TestFiles: []resultset.TestFileCount{{ContextID: id, File: "test/a.test.js", Found: 2, Passed: 1}},
				},
				Limitations: []resultset.Limitation{{ReasonCode: "test_command_override", Message: "same"}},
			}
		}
		return &Result{
			Status:    resultset.StatusCompleted,
			Findings:  []resultset.Finding{{Title: "second suite finding"}},
			TestCases: []SuiteTestCase{{Findings: []int{0}}},
			Inventory: &resultset.Inventory{
				Tests:     []resultset.PackageTests{{ContextID: id, Found: 3, Run: 3, Passed: 3}},
				TestFiles: []resultset.TestFileCount{{ContextID: id, File: "test/b.test.js", Found: 3, Passed: 3}},
			},
			Limitations: []resultset.Limitation{{ReasonCode: "test_command_override", Message: "same"}},
		}
	})

	res := testsExisting{}.Run(context.Background(), in)

	if want := (resultset.PackageTests{ContextID: id, Found: 5, Run: 5, Passed: 4, Failed: 1}); len(res.Inventory.Tests) != 1 || res.Inventory.Tests[0] != want {
		t.Errorf("counts = %+v, want one entry %+v", res.Inventory.Tests, want)
	}
	if len(res.Inventory.TestFiles) != 2 {
		t.Errorf("test files = %+v", res.Inventory.TestFiles)
	}
	if len(res.Findings) != 2 || len(res.TestCases) != 2 || res.TestCases[0].Findings[0] != 0 || res.TestCases[1].Findings[0] != 1 {
		t.Errorf("test cases must point at their own suite's Findings: %+v / %+v", res.TestCases, res.Findings)
	}
	if got := limitationsOfCode(res, "test_command_override"); len(got) != 1 {
		t.Errorf("a Limitation both suites share is listed once: %+v", res.Limitations)
	}
	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s", res.Status)
	}
}

func TestTheStatusOfAPackageWithSeveralSuitesIsTheFirstOneThatDidNotComplete(t *testing.T) {
	in := twoSuiteInput(t)
	stubSuites(t, func(_ *Input, ran int) *Result {
		if ran == 1 {
			return &Result{Status: resultset.StatusPartial, ReasonCode: "out_of_memory", Reason: "oom"}
		}
		return &Result{Status: resultset.StatusCompleted}
	})

	res := testsExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "out_of_memory" {
		t.Errorf("status = %s / %s", res.Status, res.ReasonCode)
	}
}
