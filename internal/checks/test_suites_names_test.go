package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Every record of a suite names the suite, so that a Report that holds the
// tests of a chain of npm scripts says which layer a test belongs to.

// chainInput is a package that runs two Mocha suites, one per npm script.
func chainInput(t *testing.T) *Input {
	t.Helper()
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	in.Context.Package.Tests = &discovery.TestSetup{Script: "npm run test:unit && npm run test:api", Suites: []discovery.Suite{
		{Runner: discovery.RunnerMocha, Args: []string{"--config", "test/config/mocha-unit.js"}, Origin: "test:unit"},
		{Runner: discovery.RunnerMocha, Args: []string{"--config", "test/config/mocha-api.js"}, Origin: "test:api"},
	}}
	return in
}

// stubRealResults makes every suite report the same events the way
// launchSuite does: through suiteResults.
func stubRealResults(t *testing.T, events string) {
	t.Helper()
	stubSuites(t, func(in *Input, _ int) *Result {
		sr := in.suiteResults(parseTestEvents(lines(foundAdd, foundSub, passedAdd, events, endOfSuite)), nativeBase(in.suite(), planMochaArgs(in.suite().Args, reporterPath)))
		return &Result{
			Status: resultset.StatusCompleted, Findings: sr.Findings, TestCases: sr.TestCases,
			Inventory:   &resultset.Inventory{Tests: []resultset.PackageTests{sr.Inventory}, TestFiles: sr.Files},
			Limitations: in.overrideLimitations(in.suite(), "general override", "the argument %s is dropped", nil),
		}
	})
}

func TestTestCasesFindingsAndInventoryRowsNameTheirSuite(t *testing.T) {
	in := chainInput(t)
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 2 || len(res.TestCases) != 4 {
		t.Fatalf("findings = %d, test cases = %d", len(res.Findings), len(res.TestCases))
	}
	for i, want := range []string{"test:unit", "test:api"} {
		f := res.Findings[i]
		if f.Suite == nil || *f.Suite != want {
			t.Errorf("finding %d suite = %v, want %s", i, f.Suite, want)
		}
	}
	for i, tc := range res.TestCases {
		want := []string{"test:unit", "test:unit", "test:api", "test:api"}[i]
		if tc.Suite != want {
			t.Errorf("test case %d suite = %q, want %q", i, tc.Suite, want)
		}
	}
	if len(res.Inventory.TestSuites) != 2 {
		t.Fatalf("suite rows = %+v", res.Inventory.TestSuites)
	}
	for i, want := range []string{"test:unit", "test:api"} {
		row := res.Inventory.TestSuites[i]
		if row.Suite != want || row.Found != 2 || row.Passed != 1 || row.Failed != 1 || row.ContextID != in.Context.ID {
			t.Errorf("suite row %d = %+v", i, row)
		}
	}
	if total := res.Inventory.Tests; len(total) != 1 || total[0].Found != 4 || total[0].Failed != 2 {
		t.Errorf("package totals = %+v, want one row with 4 found and 2 failed", total)
	}
	for _, f := range res.Inventory.TestFiles {
		if f.Suite != "test:unit" && f.Suite != "test:api" {
			t.Errorf("test file row without a suite: %+v", f)
		}
	}
	if len(res.Inventory.TestFiles) != 2 {
		t.Errorf("a file two suites load is counted once per suite: %+v", res.Inventory.TestFiles)
	}
}

func TestTheSameFailingTestInTwoSuitesIsTwoFindings(t *testing.T) {
	in := chainInput(t)
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	if res.Findings[0].Fingerprint == res.Findings[1].Fingerprint {
		t.Errorf("both suites' Findings have fingerprint %v, so they would count as one", res.Findings[0].Fingerprint)
	}
}

func TestAPackageWithOneSuiteKeepsItsFingerprintsAndNamesTheSuite(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	in.Shared = NewShared()
	in.Context.Package.Tests = &discovery.TestSetup{Suites: []discovery.Suite{{Runner: discovery.RunnerMocha, Origin: "scripts.test"}}}
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	f := res.Findings[0]
	want := resultset.NewFingerprint(testsExistingID, "test-failed", "test/add.test.js", "add subtracts")
	if f.Fingerprint != want {
		t.Errorf("fingerprint = %v, want the one of a package without a chain, %v", f.Fingerprint, want)
	}
	if f.Suite == nil || *f.Suite != "scripts.test" {
		t.Errorf("suite = %v", f.Suite)
	}
	if len(res.Inventory.TestSuites) != 1 || res.Inventory.TestSuites[0].Suite != "scripts.test" {
		t.Errorf("suite rows = %+v", res.Inventory.TestSuites)
	}
}

func limitationsOfCode(res *Result, code string) []resultset.Limitation {
	var out []resultset.Limitation
	for _, l := range res.Limitations {
		if l.ReasonCode == code {
			out = append(out, l)
		}
	}
	return out
}

func TestAChainSaysThatEveryStepRanWhereAndStopsAtTheFirstFailure(t *testing.T) {
	in := chainInput(t)
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	got := limitationsOfCode(res, "test_chain_all_steps_run")
	if len(got) != 1 || !strings.Contains(got[0].Message, "&&") || !strings.Contains(got[0].Message, "`test:unit`, `test:api`") {
		t.Errorf("limitations = %+v, want one test_chain_all_steps_run naming && and the suites", got)
	}
}

func TestAPackageWithOneSuiteHasNoChainLimitation(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	in.Shared = NewShared()
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	if got := limitationsOfCode(res, "test_chain_all_steps_run"); len(got) != 0 {
		t.Errorf("limitations = %+v", got)
	}
}

func TestOverrideLimitationsAreListedOncePerPackageWithTheSuitesTheyApplyTo(t *testing.T) {
	in := chainInput(t)
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	got := limitationsOfCode(res, "test_command_override")
	if len(got) != 1 {
		t.Fatalf("override limitations = %+v, want one for the package", got)
	}
	if !strings.Contains(got[0].Message, "general override") || !strings.Contains(got[0].Message, "`test:unit`, `test:api`") {
		t.Errorf("message = %q, want the override and the suites it applies to", got[0].Message)
	}
}

func TestDifferentOverridesOfTwoSuitesEachNameTheirSuite(t *testing.T) {
	in := chainInput(t)
	stubSuites(t, func(in *Input, ran int) *Result {
		lims := in.overrideLimitations(in.suite(), "general override", "the argument %s is dropped", []string{[]string{"--bail", "--reporter x"}[ran]})
		return &Result{Status: resultset.StatusCompleted, Limitations: lims}
	})

	res := testsExisting{}.Run(context.Background(), in)

	var dropped []string
	for _, l := range limitationsOfCode(res, "test_command_override") {
		if strings.Contains(l.Message, "is dropped") {
			dropped = append(dropped, l.Message)
		}
	}
	if len(dropped) != 2 || !strings.Contains(dropped[0], "--bail") || !strings.HasSuffix(dropped[0], "Applies to the suites: `test:unit`.") ||
		!strings.Contains(dropped[1], "--reporter x") || !strings.HasSuffix(dropped[1], "Applies to the suites: `test:api`.") {
		t.Errorf("dropped-argument limitations = %q", dropped)
	}
}

func TestLintStepsLeftOutOfTheChainAreListed(t *testing.T) {
	in := chainInput(t)
	in.Context.Package.Tests.LeftOut = []discovery.LeftOutStep{{Step: "eslint .", Script: "test"}}
	stubRealResults(t, failedSub)

	res := testsExisting{}.Run(context.Background(), in)

	got := limitationsOfCode(res, "test_step_left_out")
	if len(got) != 1 || !strings.Contains(got[0].Message, "eslint .") || !strings.Contains(got[0].Message, "lint.existing") {
		t.Errorf("limitations = %+v", got)
	}
}

func TestTheNodeOptionsOverrideIsListedOnceWhenBothChecksAreSelected(t *testing.T) {
	count := func(selected ...string) (existing, warnings int) {
		in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
		in.Shared = NewShared()
		in.Selection = &Selection{Effective: selected}
		stubSuites(t, func(in *Input, _ int) *Result {
			res := finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
			res.Limitations = []resultset.Limitation{in.nodeOptionsLimitation(testsExistingID)}
			return res
		})
		nodeOptions := func(res *Result) (n int) {
			for _, l := range res.Limitations {
				if strings.Contains(l.Message, "NODE_OPTIONS") {
					n++
				}
			}
			return n
		}
		return nodeOptions(testsExisting{}.Run(context.Background(), in)), nodeOptions(Implementation(runtimeWarningsID).Run(context.Background(), in))
	}

	if e, w := count(testsExistingID, runtimeWarningsID); e != 1 || w != 0 {
		t.Errorf("both selected: tests.existing lists it %d times and runtime.warnings %d times, want 1 and 0", e, w)
	}
	if _, w := count(runtimeWarningsID); w != 1 {
		t.Errorf("only runtime.warnings selected: it lists the override %d times, want once", w)
	}
}

// runtime.warnings reads every suite of the package apart, and its Findings
// name the suite they come from.

func TestRuntimeWarningsOfSeveralSuitesAreReadPerSuiteAndNameTheirSuite(t *testing.T) {
	in := chainInput(t)
	in.Selection = selectionWithout(t, testsExistingID, testsCoverageID)
	stubSuites(t, func(in *Input, ran int) *Result {
		end := endOfSuite
		if ran == 1 {
			end = `{"ev":"end","resources":["TCPServerWrap"]}`
		}
		return finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, end)), buffferDeprecation, false)
	})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("result = %s / %s / %s", res.Status, res.ReasonCode, res.Reason)
	}
	type row struct{ rule, suite string }
	var got []row
	for _, f := range res.Findings {
		if f.Suite == nil {
			t.Fatalf("finding without a suite: %+v", f)
		}
		got = append(got, row{ruleOf(f), *f.Suite})
	}
	want := []row{{"warning-from-project", "test:unit"}, {"warning-from-project", "test:api"}, {"open-resources", "test:api"}}
	if len(got) != len(want) {
		t.Fatalf("findings = %v, want %v: an open handle of one suite is reported with that suite only", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("finding %d = %v, want %v", i, got[i], want[i])
		}
	}
	if res.Findings[0].Fingerprint == res.Findings[1].Fingerprint {
		t.Errorf("the same warning in two suites is one fingerprint %v", res.Findings[0].Fingerprint)
	}
}

func TestRuntimeWarningsOfASinglePackageSuiteKeepItsFindingsWithoutASuite(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), buffferDeprecation, false))

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if len(res.Findings) != 1 || res.Findings[0].Suite != nil {
		t.Errorf("findings = %+v, want one without a suite", res.Findings)
	}
	want := resultset.NewFingerprint(runtimeWarningsID, "warning-from-project", res.Findings[0].Locations[0].Path, "DeprecationWarning DEP0005 Buffer() is deprecated due to security and usability issues. Please use the Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead. ")
	if res.Findings[0].Fingerprint != want {
		t.Errorf("fingerprint = %v, want the one that did not change", res.Findings[0].Fingerprint)
	}
}

func TestTheNodeOptionsOverrideOfRuntimeWarningsIsListedOnceForAllSuites(t *testing.T) {
	in := chainInput(t)
	in.Selection = selectionWithout(t, testsExistingID, testsCoverageID)
	stubSuites(t, func(in *Input, _ int) *Result {
		return finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
	})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	got := limitationsOfCode(res, "test_command_override")
	if len(got) != 1 || !strings.Contains(got[0].Message, "NODE_OPTIONS") || !strings.HasSuffix(got[0].Message, "Applies to the suites: `test:unit`, `test:api`.") {
		t.Errorf("override limitations = %+v, want one that names both suites", got)
	}
}

func TestALimitationOfOneSuiteOfRuntimeWarningsIsNotListedForTheOthers(t *testing.T) {
	in := chainInput(t)
	in.Context.Package.Tests.Suites[0].Env = map[string]string{"NODE_NO_WARNINGS": "1"}
	stubSuites(t, func(in *Input, _ int) *Result {
		return finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
	})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	got := limitationsOfCode(res, "warnings_suppressed")
	if len(got) != 1 || !strings.Contains(got[0].Message, "NODE_NO_WARNINGS=1") || !strings.Contains(got[0].Message, "`test:unit`") {
		t.Errorf("limitations = %+v, want one that names the suite that sets it", got)
	}
}

func TestRuntimeWarningsOfSuitesThatDidNotRunSaysSoOnce(t *testing.T) {
	in := chainInput(t)
	stubSuites(t, func(*Input, int) *Result {
		return &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{{}}}
	})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if got := limitationsOfCode(res, "tests_not_run"); res.Status != resultset.StatusCompleted || len(got) != 1 {
		t.Errorf("result = %+v", res)
	}
}
