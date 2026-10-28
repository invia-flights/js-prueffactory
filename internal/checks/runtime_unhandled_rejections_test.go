package checks

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam B for runtime.unhandled-rejections: what the first run and the strict run
// of a suite leave behind goes in, the Check's Result comes out. The containers
// are stubbed (runTestSuite); the Docker tests of the cli package cover the real
// runs on Mocha 10 and 11.

const (
	// rejectedAdd is how the strict run reports a test whose floating promise
	// rejected: the uncaught exception fails the test that was running.
	rejectedAdd = `{"ev":"result","id":1,"outcome":"failed","duration":4,"err":{"name":"Error","message":"connection refused","stack":"Error: connection refused\n    at fetchUser (/work/src/user.js:7:11)\n    at Context.<anonymous> (/work/test/add.test.js:12:5)"}}`
	hookFailed  = `{"ev":"hook_fail","title":"\"after each\" hook","hookType":"after each","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"connection refused"}}`
	crashStderr = "/work/src/user.js:7\n    throw new Error('connection refused');\n    ^\n\nError: connection refused\n    at fetchUser (/work/src/user.js:7:11)\n\nNode.js v22.11.0\n"
)

func rejectionsInput(t *testing.T) *Input {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	return in
}

func rejectionFindings(res *Result) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range res.Findings {
		if ruleOf(f) == "unhandled-rejection" {
			out = append(out, f)
		}
	}
	return out
}

// strictRuns gives the Result of the first run and of the strict run, whatever
// their numbers.
func strictRuns(t *testing.T, first, strict func(in *Input) *Result) *[]string {
	return stubRuns(t, func(in *Input, n int) *Result {
		if n == 1 {
			return first(in)
		}
		return strict(in)
	})
}

func okRun(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) }

// crashedRun is a run whose process died after the first test: no end event.
func crashedRun(in *Input, results ...string) *Result {
	l := append([]string{foundAdd, foundSub}, results...)
	r := finishedSuite(in, parseTestEvents(lines(l...)), crashStderr, false)
	code := 1
	r.Tool = &resultset.Tool{Name: "mocha", ExitCode: &code}
	return r
}

func TestUnhandledRejectionsIsImplementedAndAppliesWhereTestsExistingApplies(t *testing.T) {
	e, ok := Lookup(runtimeUnhandledRejectionsID)
	if !ok || e.Status != Implemented || e.CanFireGates || e.Area != AreaCodeCorrectness || e.Scope != PerPackage {
		t.Fatalf("entry = %+v", e)
	}
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	want, wantWhy := testsExisting{}.Applicability(in.Project, in.Context)
	got, why := Implementation(runtimeUnhandledRejectionsID).Applicability(in.Project, in.Context)
	if got != want {
		t.Errorf("applicability = %s (%s), want %s (%s), like tests.existing", got, why, want, wantWhy)
	}
	root := &in.Project.Contexts[0]
	if app, _ := Implementation(runtimeUnhandledRejectionsID).Applicability(in.Project, root); app != resultset.NotApplicable {
		t.Errorf("the project Context has no tests, applicability = %s", app)
	}
	in.Context.Package.Tests = nil
	if app, _ := Implementation(runtimeUnhandledRejectionsID).Applicability(in.Project, in.Context); app != resultset.NotApplicable {
		t.Errorf("a package without tests: applicability = %s", app)
	}
}

func TestTheStrictRunIsOneRepeatRunWithTheFlagInNodeOptionsAfterTheTestsFlakyRuns(t *testing.T) {
	in := rejectionsInput(t) // no Selection: every Check, tests.flaky included
	var strictOptions []string
	order := stubRuns(t, func(in *Input, n int) *Result {
		if in.repeat != nil && in.repeat.checkID == runtimeUnhandledRejectionsID {
			strictOptions = append(strictOptions, in.repeat.nodeOptions)
		}
		return okRun(in)
	})

	testsExisting{}.Run(context.Background(), in)
	Implementation(testsFlakyID).Run(context.Background(), in)
	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "scripts.test#1 scripts.test#2 scripts.test#3 scripts.test#4" {
		t.Errorf("runs = %q, want the strict run to be the run after the two of tests.flaky", got)
	}
	if len(strictOptions) != 1 || strictOptions[0] != "--unhandled-rejections=strict" {
		t.Errorf("NODE_OPTIONS additions of the strict run = %q", strictOptions)
	}
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Errorf("status = %s, findings = %+v", res.Status, res.Findings)
	}
}

func TestTheStrictRunIsTheSecondRunWhenTestsFlakyIsNotSelected(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	order := stubRuns(t, func(in *Input, n int) *Result { return okRun(in) })

	Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "scripts.test#1 scripts.test#2" {
		t.Errorf("runs = %q", got)
	}
}

func TestTheStrictRunsFirstRunRunsEvenWhenTestsExistingIsNotSelected(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsExistingID)
	order := stubRuns(t, func(in *Input, n int) *Result { return okRun(in) })

	Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); !strings.HasPrefix(got, "scripts.test#1 ") {
		t.Errorf("runs = %q", got)
	}
}

func TestATestThatPassedNormallyAndFailsInTheStrictRunIsOneLikelyWarningWithTheStrictRunsError(t *testing.T) {
	in := rejectionsInput(t)
	strictRuns(t, okRun, func(in *Input) *Result { return suiteRunWith(in, rejectedAdd, passedSub) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	fs := rejectionFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want one", res.Findings)
	}
	f := fs[0]
	if f.CheckID != runtimeUnhandledRejectionsID || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
		t.Errorf("finding = %+v, want a warning, likely, no Gate", f)
	}
	if f.Suite == nil || *f.Suite != "scripts.test" {
		t.Errorf("suite = %v", f.Suite)
	}
	if !strings.Contains(f.Title, "add adds") {
		t.Errorf("title = %q, want the test", f.Title)
	}
	if len(f.Evidence) != 2 || f.Evidence[0].Text != "connection refused" ||
		!strings.Contains(f.Evidence[1].Text, "at fetchUser (src/user.js:7:11)") {
		t.Errorf("evidence = %+v, want the strict run's message and stack", f.Evidence)
	}
	for _, e := range f.Evidence {
		if e.Trust != resultset.TrustUntrusted {
			t.Errorf("evidence %+v: error text from the project is untrusted", e)
		}
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/add.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 12 {
		t.Errorf("locations = %+v, want the line of the test file in the stack", f.Locations)
	}
	tr := f.Reproduction.Test
	if tr == nil || tr.FullTitle != "add adds" || tr.File != "test/add.test.js" ||
		strings.Join(tr.NativeCommand, " ") != "env NODE_OPTIONS=--unhandled-rejections=strict npx mocha --fgrep add adds test/add.test.js" {
		t.Errorf("reproduction = %+v, want the single-test command with the flag", tr)
	}
}

func TestTheNativeCommandExtendsTheProjectsOwnNodeOptions(t *testing.T) {
	got := strictNativeCommand([]string{"env", "FOO=1", "NODE_OPTIONS=--require ./setup.js", "npx", "mocha", "x.js"})
	want := "env FOO=1 NODE_OPTIONS=--require ./setup.js --unhandled-rejections=strict npx mocha x.js"
	if strings.Join(got, " ") != want {
		t.Errorf("command = %q, want %q", strings.Join(got, " "), want)
	}
	got = strictNativeCommand([]string{"env", "FOO=1", "npx", "mocha"})
	if want := "env NODE_OPTIONS=--unhandled-rejections=strict FOO=1 npx mocha"; strings.Join(got, " ") != want {
		t.Errorf("command = %q, want %q", strings.Join(got, " "), want)
	}
}

func TestATestThatNeverRanInTheStrictRunBecauseOfAFailedHookIsAFinding(t *testing.T) {
	in := rejectionsInput(t)
	strictRuns(t, okRun, func(in *Input) *Result { return suiteRunWith(in, hookFailed) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	fs := rejectionFindings(res)
	if len(fs) != 2 {
		t.Fatalf("findings = %+v, want both tests the hook kept from running", res.Findings)
	}
	if text := fs[0].Evidence[0].Text; !strings.HasPrefix(text, "never run in the strict run") || !strings.Contains(text, "connection refused") {
		t.Errorf("evidence = %q", text)
	}
}

func TestOnlyATestThatPassedInTheFirstRunCanBeAFinding(t *testing.T) {
	in := rejectionsInput(t)
	strictRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, failedAdd, skippedSub) },
		func(in *Input) *Result { return suiteRunWith(in, failedAdd, passedSub) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v: a test that failed before is reported by tests.existing, and a skipped one takes no part", res.Findings)
	}
}

const skippedSub = `{"ev":"result","id":2,"outcome":"skipped","duration":0}`

func TestATestOnlyTheStrictRunFoundIsNotAFinding(t *testing.T) {
	in := rejectionsInput(t)
	generated := `{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"generated","fullTitle":"add generated","suitePath":["add"]}`
	strictRuns(t, okRun, func(in *Input) *Result {
		return finishedSuite(in, parseTestEvents(lines(foundAdd, foundSub, generated, passedAdd, passedSub, `{"ev":"result","id":3,"outcome":"failed","duration":1}`, endOfSuite)), "", false)
	})

	if res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in); len(res.Findings) != 0 {
		t.Errorf("findings = %+v", res.Findings)
	}
}

// --- tests.flaky overlap ---

func TestTestsThatTestsFlakyReportsAreLeftOutAndCounted(t *testing.T) {
	in := rejectionsInput(t) // tests.flaky is selected
	stubRuns(t, func(in *Input, n int) *Result {
		switch n {
		case 1, 3:
			return okRun(in)
		case 2: // a flaky test: fails in run 2 of tests.flaky only
			return suiteRunWith(in, failedAdd, passedSub)
		}
		// The strict run fails the flaky test and one other.
		return suiteRunWith(in, rejectedAdd, `{"ev":"result","id":2,"outcome":"failed","duration":1,"err":{"name":"Error","message":"late"}}`)
	})

	testsExisting{}.Run(context.Background(), in)
	flaky := Implementation(testsFlakyID).Run(context.Background(), in)
	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(flakyFindings(flaky)) != 1 {
		t.Fatalf("tests.flaky findings = %+v", flaky.Findings)
	}
	fs := rejectionFindings(res)
	if len(fs) != 1 || !strings.Contains(fs[0].Title, "add subtracts") {
		t.Fatalf("findings = %+v, want only the test tests.flaky did not explain", res.Findings)
	}
	if n := metricValue(t, res, "explained_by_flakiness"); n != 1 {
		t.Errorf("explained_by_flakiness = %v, want 1", n)
	}
	for _, l := range res.Limitations {
		if l.ReasonCode == "flakiness_not_excluded" {
			t.Errorf("tests.flaky ran, so flakiness is excluded: %+v", l)
		}
	}
}

func TestWithoutTestsFlakyALimitationSaysDifferencesMayBeFlakiness(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result { return suiteRunWith(in, rejectedAdd, passedSub) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	var found *resultset.Limitation
	for i, l := range res.Limitations {
		if l.ReasonCode == "flakiness_not_excluded" {
			found = &res.Limitations[i]
		}
	}
	if found == nil || found.CheckID == nil || *found.CheckID != runtimeUnhandledRejectionsID || !strings.Contains(found.Message, "flak") {
		t.Fatalf("limitations = %+v, want flakiness_not_excluded", res.Limitations)
	}
	if len(rejectionFindings(res)) != 1 {
		t.Errorf("nothing is left out without tests.flaky: %+v", res.Findings)
	}
}

func TestTestsFlakySelectedButWithoutAResultAlsoLeavesTheLimitation(t *testing.T) {
	in := rejectionsInput(t) // selected, but never run in this Run
	strictRuns(t, okRun, okRun)

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	for _, l := range res.Limitations {
		if l.ReasonCode == "flakiness_not_excluded" {
			return
		}
	}
	t.Errorf("limitations = %+v: nothing excluded flakiness", res.Limitations)
}

// --- crashes ---

func TestAStrictRunThatCrashesTheProcessIsOneFindingForTheSuiteAndItsNeverRunTestsAreNotReported(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result { return crashedRun(in, passedAdd) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v, want one for the suite: add subtracts never ran and is not reported", res.Findings)
	}
	f := res.Findings[0]
	if ruleOf(f) != "unhandled-rejection-crash" || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
		t.Errorf("finding = %+v", f)
	}
	if f.Suite == nil || *f.Suite != "scripts.test" {
		t.Errorf("suite = %v", f.Suite)
	}
	if !strings.Contains(f.Message, "exited with code 1") {
		t.Errorf("message = %q, want the exit code", f.Message)
	}
	if len(f.Evidence) != 1 || f.Evidence[0].Trust != resultset.TrustUntrusted ||
		!strings.Contains(f.Evidence[0].Text, "Error: connection refused") || strings.Contains(f.Evidence[0].Text, "/work/") {
		t.Errorf("evidence = %+v, want the process output with project-relative paths", f.Evidence)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "src/user.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 7 {
		t.Errorf("locations = %+v, want the frame in the project", f.Locations)
	}
	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s: a crash is the result, not a failure of the Check", res.Status)
	}
}

// Mocha does not always die: an uncaught error while no test runs, such as a
// rejection while a test file loads, is reported by Mocha as a failure of
// "Uncaught error outside test suite", and the run ends without running the
// rest.
const outsideSuiteFailed = `{"ev":"result","title":"Uncaught error outside test suite","fullTitle":"Uncaught error outside test suite","outcome":"failed","duration":0,"err":{"name":"Error","message":"rejected while the file loads","stack":"Error: rejected while the file loads\n    at Object.<anonymous> (/work/test/add.test.js:5:16)"}}`

func TestAnUncaughtErrorOutsideAnyTestThatMochaReportsIsTheOneFindingToo(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result { return suiteRunWith(in, outsideSuiteFailed) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v, want one for the suite: the two tests that never ran are not reported on their own", res.Findings)
	}
	f := res.Findings[0]
	if ruleOf(f) != "unhandled-rejection-crash" || f.Gate || f.Confidence != resultset.ConfidenceLikely {
		t.Errorf("finding = %+v", f)
	}
	if len(f.Evidence) != 2 || f.Evidence[0].Text != "rejected while the file loads" || !strings.Contains(f.Evidence[1].Text, "test/add.test.js:5:16") {
		t.Errorf("evidence = %+v, want the error Mocha recorded", f.Evidence)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/add.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 5 {
		t.Errorf("locations = %+v", f.Locations)
	}
}

func TestAnUncaughtErrorOutsideAnyTestThatTheFirstRunHadTooIsNoWorkOfTheFlag(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, func(in *Input) *Result { return suiteRunWith(in, outsideSuiteFailed) }, func(in *Input) *Result { return suiteRunWith(in, outsideSuiteFailed) })

	if res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in); len(res.Findings) != 0 {
		t.Errorf("findings = %+v", res.Findings)
	}
}

func TestATestFileWhoseProcessOnlyStoppedInTheStrictRunIsTheOneFindingAndItsTestsAreNotReported(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	fileFail := `{"ev":"file_fail","file":"/work/test/add.test.js","err":{"name":"Error","message":"user service is down"},"text":"Error: user service is down\n    at load (/work/src/user.js:3:9)\n"}`
	strictRuns(t, okRun, func(in *Input) *Result { return suiteRunWith(in, fileFail) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 1 || ruleOf(res.Findings[0]) != "unhandled-rejection-crash" {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if ev := res.Findings[0].Evidence; len(ev) != 1 || !strings.Contains(ev[0].Text, "user service is down") {
		t.Errorf("evidence = %+v, want what the file's process printed", ev)
	}
}

func TestATestThatFailedBeforeTheCrashIsStillItsOwnFinding(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result { return crashedRun(in, rejectedAdd) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(rejectionFindings(res)) != 1 || len(res.Findings) != 2 {
		t.Errorf("findings = %+v, want the failed test and the crash", res.Findings)
	}
}

func TestACrashBeforeAnyTestReportsIsAFindingToo(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result {
		r := finishedSuite(in, parseTestEvents(nil), crashStderr, false)
		code := 1
		r.Tool = &resultset.Tool{Name: "mocha", ExitCode: &code}
		return r
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 1 || ruleOf(res.Findings[0]) != "unhandled-rejection-crash" || res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s, findings = %+v", res.Status, res.Findings)
	}
}

func TestACrashThatTheFirstRunHadTooIsNotBlamedOnTheFlag(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, func(in *Input) *Result { return crashedRun(in, passedAdd) }, func(in *Input) *Result { return crashedRun(in, passedAdd) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v: tests.existing reports the aborted run", res.Findings)
	}
}

// --- limits and failures ---

func TestAStrictRunThatTimesOutMakesTheExecutionPartialAndKeepsTheFindingsItHas(t *testing.T) {
	old := repeatRunTimeout
	repeatRunTimeout = 20 * time.Millisecond
	t.Cleanup(func() { repeatRunTimeout = old })
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result {
		r := cutRunWith(in, rejectedAdd)
		return r
	})
	inner := runTestSuite
	runTestSuite = func(ctx context.Context, in *Input) *Result {
		r := inner(ctx, in)
		if in.repeat != nil {
			<-ctx.Done()
		}
		return r
	}

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "repeat_run_timed_out" || !res.KeepsStatus {
		t.Errorf("status = %s (%s), keeps = %v", res.Status, res.ReasonCode, res.KeepsStatus)
	}
	fs := rejectionFindings(res)
	if len(fs) != 1 || !strings.Contains(fs[0].Title, "add adds") {
		t.Errorf("findings = %+v: the test that failed before the limit is kept, the one never reached is not", res.Findings)
	}
}

func TestACancelledStrictRunLeavesTheStatusToTheEngine(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	ctx, cancel := context.WithCancel(context.Background())
	strictRuns(t, okRun, func(in *Input) *Result {
		cancel()
		return cutRunWith(in)
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(ctx, in)

	if res.KeepsStatus {
		t.Errorf("a user's cancellation must reach the Report as cancelled: %+v", res)
	}
}

func TestAStrictRunThatCouldNotStartMakesTheExecutionPartial(t *testing.T) {
	in := rejectionsInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okRun, func(in *Input) *Result {
		return &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready", Reason: "Service cache did not come up"}
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "repeat_run_failed" || !strings.Contains(res.Reason, "Service cache did not come up") {
		t.Errorf("status = %s (%s): %s", res.Status, res.ReasonCode, res.Reason)
	}
}

func TestASuiteThatCouldNotStartInTheFirstRunGetsNoStrictRunAndTheCheckReportsWhy(t *testing.T) {
	in := rejectionsInput(t)
	order := stubRuns(t, func(in *Input, n int) *Result {
		return &Result{Status: resultset.StatusBlocked, ReasonCode: "service_unavailable", Reason: "no Valkey"}
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(*order) != 1 || res.Status != resultset.StatusBlocked || res.ReasonCode != "service_unavailable" {
		t.Errorf("runs = %v, result = %+v", *order, res)
	}
}

func TestAnUnsupportedPackageGetsNoStrictRun(t *testing.T) {
	in := rejectionsInput(t)
	in.Context.Package.Tests = &discovery.TestSetup{Unsupported: &discovery.Unsupported{Code: "test_runner_not_implemented", Reason: "tests run by jest are not supported yet"}}
	order := stubRuns(t, func(in *Input, n int) *Result { return &Result{} })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(*order) != 0 || res.Status != resultset.StatusUnsupported || res.ReasonCode != "test_runner_not_implemented" {
		t.Errorf("runs = %v, result = %+v", *order, res)
	}
}

func TestEverySuiteOfAPackageGetsItsOwnStrictRunAndItsFindingsNameTheSuite(t *testing.T) {
	in := twoSuiteInput(t)
	in.Selection = selectionWithout(t, testsFlakyID)
	order := stubRuns(t, func(in *Input, n int) *Result {
		if n == 2 {
			return suiteRunWith(in, rejectedAdd, passedSub)
		}
		return okRun(in)
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "test:unit#1 test:api#1 test:unit#2 test:api#2" {
		t.Errorf("runs = %q", got)
	}
	fs := rejectionFindings(res)
	if len(fs) != 2 || *fs[0].Suite != "test:unit" || *fs[1].Suite != "test:api" || fs[0].Fingerprint == fs[1].Fingerprint {
		t.Errorf("findings = %+v, want one per suite with different fingerprints", fs)
	}
}
