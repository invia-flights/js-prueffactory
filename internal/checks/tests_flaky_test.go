package checks

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam B for tests.flaky: what the runs of a suite leave behind goes in, the
// Check's Result comes out. The containers are stubbed (runTestSuite); the
// Docker tests of the cli package cover the real runs.

const (
	passedSub = `{"ev":"result","id":2,"outcome":"passed","duration":2}`
	failedAdd = `{"ev":"result","id":1,"outcome":"failed","duration":5,"err":{"name":"Error","message":"counter was 2 and not 1","stack":"Error: counter was 2 and not 1\n    at Context.<anonymous> (/work/test/add.test.js:11:5)"}}`
	retryAdd  = `{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"socket hang up"}}`
	skippedAd = `{"ev":"result","id":1,"outcome":"skipped","duration":0}`
	todoAdd   = `{"ev":"result","id":1,"outcome":"todo","duration":0}`
)

// suiteRunWith is the Result of one finished run of a suite that found the two
// tests of add.test.js and recorded the given result lines.
func suiteRunWith(in *Input, results ...string) *Result {
	l := append([]string{foundAdd, foundSub}, results...)
	return finishedSuite(in, parseTestEvents(lines(append(l, endOfSuite)...)), "", false)
}

// cutRunWith is a run the Check's time limit stopped: no end event.
func cutRunWith(in *Input, results ...string) *Result {
	l := append([]string{foundAdd, foundSub}, results...)
	r := finishedSuite(in, parseTestEvents(lines(l...)), "", false)
	r.Status, r.ReasonCode = resultset.StatusTimedOut, "timeout"
	return r
}

// stubRuns replaces the run of a suite with a function of the run's number: 1
// is the shared first run, 2 and 3 are the repeats. It records the runs as
// "suite#number" in order.
func stubRuns(t *testing.T, run func(in *Input, number int) *Result) *[]string {
	t.Helper()
	var order []string
	old := runTestSuite
	t.Cleanup(func() { runTestSuite = old })
	runTestSuite = func(ctx context.Context, in *Input) *Result {
		n := 1
		if in.repeat != nil {
			n = in.repeat.number
		}
		order = append(order, fmt.Sprintf("%s#%d", in.suite().Origin, n))
		return run(in, n)
	}
	return &order
}

// threeRuns gives the Result of each of the three runs of a one-suite package.
func threeRuns(t *testing.T, first, second, third func(in *Input) *Result) *[]string {
	return stubRuns(t, func(in *Input, n int) *Result {
		return []func(*Input) *Result{first, second, third}[n-1](in)
	})
}

func flakyInput(t *testing.T) *Input {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	return in
}

func flakyFindings(res *Result) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range res.Findings {
		if ruleOf(f) == "flaky-test" {
			out = append(out, f)
		}
	}
	return out
}

func metricValue(t *testing.T, res *Result, name string) float64 {
	t.Helper()
	for _, m := range res.Metrics {
		if m.Name == name && m.Value != nil {
			return *m.Value
		}
	}
	t.Fatalf("no metric %q in %+v", name, res.Metrics)
	return 0
}

func TestFlakyIsImplementedAndAppliesWhereTestsExistingApplies(t *testing.T) {
	e, ok := Lookup(testsFlakyID)
	if !ok || e.Status != Implemented || e.CanFireGates || e.Area != AreaTests {
		t.Fatalf("entry = %+v", e)
	}
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	want, wantWhy := testsExisting{}.Applicability(in.Project, in.Context)
	got, why := Implementation(testsFlakyID).Applicability(in.Project, in.Context)
	if got != want {
		t.Errorf("applicability = %s (%s), want %s (%s), like tests.existing", got, why, want, wantWhy)
	}
	root := &in.Project.Contexts[0]
	if app, _ := Implementation(testsFlakyID).Applicability(in.Project, root); app != resultset.NotApplicable {
		t.Errorf("the project Context has no tests, applicability = %s", app)
	}
	in.Context.Package.Tests = nil
	if app, _ := Implementation(testsFlakyID).Applicability(in.Project, in.Context); app != resultset.NotApplicable {
		t.Errorf("a package without tests: applicability = %s", app)
	}
}

func TestEachSuiteRunsTwoMoreTimesAfterTheSharedFirstRunOneAfterAnother(t *testing.T) {
	in := flakyInput(t)
	order := threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	// tests.existing performs the first run; tests.flaky reads it.
	testsExisting{}.Run(context.Background(), in)
	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "scripts.test#1 scripts.test#2 scripts.test#3" {
		t.Errorf("runs = %q, want the first run once, then two repeats in sequence", got)
	}
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Errorf("status = %s, findings = %+v", res.Status, res.Findings)
	}
	if n := metricValue(t, res, "flaky_tests"); n != 0 {
		t.Errorf("flaky_tests = %v, want 0", n)
	}
}

func TestTheFirstRunRunsEvenWhenTestsExistingIsNotSelected(t *testing.T) {
	in := flakyInput(t)
	in.Selection = selectionWithout(t, testsExistingID)
	order := threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	Implementation(testsFlakyID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "scripts.test#1 scripts.test#2 scripts.test#3" {
		t.Errorf("runs = %q", got)
	}
}

func TestATestThatPassesFailsAndPassesIsOneFlakyTestWithTheOutcomeOfEachRun(t *testing.T) {
	in := flakyInput(t)
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, failedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	fs := flakyFindings(res)
	if len(fs) != 1 {
		t.Fatalf("Flaky test Findings = %d, want 1 (%+v)", len(fs), res.Findings)
	}
	f := fs[0]
	if f.CheckID != testsFlakyID || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceConfirmed || f.Gate {
		t.Errorf("finding = %+v, want a warning, confirmed, no Gate", f)
	}
	if f.Suite == nil || *f.Suite != "scripts.test" {
		t.Errorf("suite = %v", f.Suite)
	}
	if want := "Flaky test: add adds (runs: passed, failed, passed)"; f.Title != want {
		t.Errorf("title = %q, want %q", f.Title, want)
	}
	// The test title is the project's text: it stands in the Message as a code span.
	if !strings.HasPrefix(f.Message, "The test `add adds` passed in run 1, 3 and failed") {
		t.Errorf("message = %q, want the test title as a code span", f.Message)
	}
	if len(f.Evidence) != 3 {
		t.Fatalf("evidence = %+v, want one item per run", f.Evidence)
	}
	for i, want := range []string{
		"run 1 (first run): passed",
		"run 2: failed\n  attempt 1 (final): failed: counter was 2 and not 1",
		"run 3: passed",
	} {
		if f.Evidence[i].Text != want || f.Evidence[i].Trust != resultset.TrustUntrusted {
			t.Errorf("evidence %d = %q, want %q", i, f.Evidence[i].Text, want)
		}
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/add.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 11 {
		t.Errorf("locations = %+v, want the failing line of the test file", f.Locations)
	}
	if tr := f.Reproduction.Test; tr == nil || tr.FullTitle != "add adds" || tr.File != "test/add.test.js" ||
		strings.Join(tr.NativeCommand, " ") != "npx mocha --fgrep add adds test/add.test.js" {
		t.Errorf("reproduction = %+v, want the native single-test command", f.Reproduction.Test)
	}
	if n := metricValue(t, res, "flaky_tests"); n != 1 {
		t.Errorf("flaky_tests = %v, want 1", n)
	}
}

func TestATestThatFailsInEveryRunIsAFailedTestAndNotAFlakyTest(t *testing.T) {
	in := flakyInput(t)
	failing := func(in *Input) *Result { return suiteRunWith(in, failedAdd, passedSub) }
	threeRuns(t, failing, failing, failing)

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v, want none: tests.existing reports the failure", res.Findings)
	}
}

func TestATestThatNeverRanThroughAFailedHookCountsAsFailedInTheComparison(t *testing.T) {
	in := flakyInput(t)
	hook := `{"ev":"hook_fail","title":"\"before all\" hook","hookType":"before all","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"no connection"}}`
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, hook) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if got := len(flakyFindings(res)); got != 2 {
		t.Fatalf("Flaky tests = %d, want both tests the hook kept from running", got)
	}
	if text := flakyFindings(res)[0].Evidence[1].Text; !strings.HasPrefix(text, "run 2: never run") {
		t.Errorf("evidence = %q, want the run reported as never run", text)
	}
}

func TestATestThatOnlyPassedAfterMochaRetriesIsFlakyEvenWhenEveryRunPasses(t *testing.T) {
	in := flakyInput(t)
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, retryAdd, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	fs := flakyFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if want := "run 1 (first run): passed after 2 attempts\n  attempt 1: failed: socket hang up\n  attempt 2 (final): passed"; fs[0].Evidence[0].Text != want {
		t.Errorf("evidence = %q, want %q", fs[0].Evidence[0].Text, want)
	}
	if !strings.Contains(fs[0].Title, "passed after 2 attempts") {
		t.Errorf("title = %q", fs[0].Title)
	}
}

func TestSkippedAndTodoTestsTakePartInNoComparison(t *testing.T) {
	in := flakyInput(t)
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, skippedAd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result { return suiteRunWith(in, todoAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v, want none", res.Findings)
	}
}

func TestATestFoundInOnlySomeRunsIsANoteAndNotAFlakyTest(t *testing.T) {
	in := flakyInput(t)
	generated := `{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"generated at load time","fullTitle":"add generated at load time","suitePath":["add"]}`
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result {
			r := finishedSuite(in, parseTestEvents(lines(foundAdd, foundSub, generated, passedAdd, passedSub, `{"ev":"result","id":3,"outcome":"failed","duration":1}`, endOfSuite)), "", false)
			return r
		},
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(flakyFindings(res)) != 0 {
		t.Errorf("a test that only one run found is not flaky: %+v", res.Findings)
	}
	var notes []resultset.Finding
	for _, f := range res.Findings {
		if ruleOf(f) == "test-in-some-runs" {
			notes = append(notes, f)
		}
	}
	if len(notes) != 1 || notes[0].Severity != resultset.SeverityNote || notes[0].Gate ||
		!strings.Contains(notes[0].Title, "add generated at load time") || !strings.Contains(notes[0].Title, "found in only some runs") {
		t.Fatalf("notes = %+v, want one note naming the test", notes)
	}
	if n := metricValue(t, res, "flaky_tests"); n != 0 {
		t.Errorf("flaky_tests = %v: the note is not counted", n)
	}
}

func TestARepeatRunThatTimesOutMakesTheExecutionPartialAndKeepsTheFinishedComparisons(t *testing.T) {
	old := repeatRunTimeout
	repeatRunTimeout = 20 * time.Millisecond
	t.Cleanup(func() { repeatRunTimeout = old })
	in := flakyInput(t)
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result {
			// The second run got as far as the first test, which failed.
			return cutRunWith(in, failedAdd)
		},
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) })
	// The stub of the second run waits for its limit like a real container.
	inner := runTestSuite
	runTestSuite = func(ctx context.Context, in *Input) *Result {
		r := inner(ctx, in)
		if in.repeat != nil && in.repeat.number == 2 {
			<-ctx.Done()
		}
		return r
	}

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "repeat_run_timed_out" || !res.KeepsStatus {
		t.Errorf("status = %s (%s), keeps = %v, want partial: repeat_run_timed_out, kept by the engine", res.Status, res.ReasonCode, res.KeepsStatus)
	}
	fs := flakyFindings(res)
	if len(fs) != 1 || !strings.Contains(fs[0].Title, "add adds") {
		t.Fatalf("findings = %+v, want the one comparison that finished", res.Findings)
	}
	if !strings.Contains(fs[0].Title, "(runs: passed, failed, passed)") {
		t.Errorf("title = %q", fs[0].Title)
	}
	for _, f := range res.Findings {
		if strings.Contains(f.Title, "add subtracts") {
			t.Errorf("a test the cut run never reached is not compared: %+v", f)
		}
	}
}

func TestTheBudgetEndingDuringARepeatRunMakesTheExecutionPartialAndStopsTheLaterRuns(t *testing.T) {
	in := twoSuiteInput(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	order := stubRuns(t, func(in *Input, n int) *Result {
		if n == 2 && in.suite().Origin == "test:unit" {
			<-ctx.Done()
			return cutRunWith(in)
		}
		return suiteRunWith(in, passedAdd, passedSub)
	})

	res := Implementation(testsFlakyID).Run(ctx, in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "budget_exhausted" || !res.KeepsStatus {
		t.Errorf("status = %s (%s), keeps = %v", res.Status, res.ReasonCode, res.KeepsStatus)
	}
	if got := strings.Join(*order, " "); got != "test:unit#1 test:api#1 test:unit#2" {
		t.Errorf("runs = %q, want nothing to start once the Budget has ended", got)
	}
}

func TestACancelledRunLeavesTheStatusToTheEngine(t *testing.T) {
	in := flakyInput(t)
	ctx, cancel := context.WithCancel(context.Background())
	stubRuns(t, func(in *Input, n int) *Result {
		if n == 2 {
			cancel()
			return cutRunWith(in)
		}
		return suiteRunWith(in, passedAdd, passedSub)
	})

	res := Implementation(testsFlakyID).Run(ctx, in)

	if res.KeepsStatus {
		t.Errorf("a user's cancellation must reach the Report as cancelled, not as partial: %+v", res)
	}
}

func TestEverySuiteOfAPackageGetsItsOwnTwoRepeatsAndItsFindingsNameTheSuite(t *testing.T) {
	in := twoSuiteInput(t)
	order := stubRuns(t, func(in *Input, n int) *Result {
		if n == 2 {
			return suiteRunWith(in, failedAdd, passedSub)
		}
		return suiteRunWith(in, passedAdd, passedSub)
	})

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if got := strings.Join(*order, " "); got != "test:unit#1 test:api#1 test:unit#2 test:unit#3 test:api#2 test:api#3" {
		t.Errorf("runs = %q", got)
	}
	fs := flakyFindings(res)
	if len(fs) != 2 {
		t.Fatalf("findings = %+v, want one per suite", res.Findings)
	}
	if *fs[0].Suite != "test:unit" || *fs[1].Suite != "test:api" || fs[0].Fingerprint == fs[1].Fingerprint {
		t.Errorf("suites %q, %q with fingerprints %v, %v", *fs[0].Suite, *fs[1].Suite, fs[0].Fingerprint, fs[1].Fingerprint)
	}
}

func TestASuiteThatCouldNotStartGetsNoRepeatsAndTheCheckReportsWhy(t *testing.T) {
	in := flakyInput(t)
	order := stubRuns(t, func(in *Input, n int) *Result {
		return &Result{Status: resultset.StatusBlocked, ReasonCode: "service_unavailable", Reason: "no Valkey"}
	})

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(*order) != 1 || res.Status != resultset.StatusBlocked || res.ReasonCode != "service_unavailable" {
		t.Errorf("runs = %v, result = %+v", *order, res)
	}
}

func TestAnUnsupportedPackageIsUnsupportedAndRunsNothing(t *testing.T) {
	in := flakyInput(t)
	in.Context.Package.Tests = &discovery.TestSetup{Unsupported: &discovery.Unsupported{Code: "test_runner_not_implemented", Reason: "tests run by jest are not supported yet"}}
	order := stubRuns(t, func(in *Input, n int) *Result { return &Result{} })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(*order) != 0 || res.Status != resultset.StatusUnsupported || res.ReasonCode != "test_runner_not_implemented" {
		t.Errorf("runs = %v, result = %+v", *order, res)
	}
}

func TestARepeatRunThatFailsToStartMakesTheExecutionPartial(t *testing.T) {
	in := flakyInput(t)
	threeRuns(t,
		func(in *Input) *Result { return suiteRunWith(in, passedAdd, passedSub) },
		func(in *Input) *Result {
			return &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready", Reason: "Service cache did not come up"}
		},
		func(in *Input) *Result { return suiteRunWith(in, failedAdd, passedSub) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "repeat_run_failed" || !strings.Contains(res.Reason, "Service cache did not come up") {
		t.Errorf("status = %s (%s): %s", res.Status, res.ReasonCode, res.Reason)
	}
	if fs := flakyFindings(res); len(fs) != 1 || !strings.Contains(fs[0].Title, "(runs: passed, failed)") {
		t.Errorf("the finished comparison is kept, with the runs that took part: %+v", res.Findings)
	}
}

// --- what makes a run a repeat run ---

func TestARepeatRunGetsContainerNamesOfItsOwnAndNoCoverageAndNoWarningFlags(t *testing.T) {
	in := flakyInput(t)
	rep := in.forRepeat(repeatRun{checkID: testsFlakyID, number: 2})

	if rep.suiteSuffix() == in.suiteSuffix() || !strings.HasPrefix(rep.suiteSuffix(), in.suiteSuffix()) {
		t.Errorf("suffixes %q and %q must differ, so Services and networks are fresh", in.suiteSuffix(), rep.suiteSuffix())
	}
	if two := in.forRepeat(repeatRun{checkID: testsFlakyID, number: 3}); two.suiteSuffix() == rep.suiteSuffix() {
		t.Errorf("the two repeats share the suffix %q", rep.suiteSuffix())
	}
	if in.wantsCoverage() == false || rep.wantsCoverage() {
		t.Errorf("a repeat run is not measured by c8, the first run is: %v, %v", in.wantsCoverage(), rep.wantsCoverage())
	}
	env := map[string]string{"NODE_OPTIONS": "--require ./setup.js"}
	marker := rep.addWarningsEnv(env)
	if env["NODE_OPTIONS"] != "--require ./setup.js" {
		t.Errorf("NODE_OPTIONS = %q, want the project's value without our warning flags", env["NODE_OPTIONS"])
	}
	if marker == nil || env["JSPF_END_MARKER"] != marker.Text {
		t.Errorf("a repeat run is watched for a process that stays alive too: %+v", marker)
	}
}

func TestARepeatRunCanAddToNodeOptionsAfterTheProjectsValue(t *testing.T) {
	in := flakyInput(t).forRepeat(repeatRun{checkID: testsFlakyID, number: 2, nodeOptions: "--unhandled-rejections=strict"})
	env := map[string]string{"NODE_OPTIONS": "--require ./setup.js"}
	in.addWarningsEnv(env)
	if env["NODE_OPTIONS"] != "--require ./setup.js --unhandled-rejections=strict" {
		t.Errorf("NODE_OPTIONS = %q", env["NODE_OPTIONS"])
	}
}

func TestTheCommandLogOfARepeatRunBelongsToTheCheckThatRanIt(t *testing.T) {
	in := flakyInput(t)
	if got := in.testLogPath(); got != "artifacts/tests.existing/"+in.Context.ID+"/test-output.log" {
		t.Errorf("first run log = %q", got)
	}
	rep := in.forRepeat(repeatRun{checkID: testsFlakyID, number: 3})
	if got := rep.testLogPath(); got != "artifacts/tests.flaky/"+in.Context.ID+"/test-output-run3.log" {
		t.Errorf("repeat log = %q", got)
	}
}
