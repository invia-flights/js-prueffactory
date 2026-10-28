package checks

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam B for the runtime.warnings Check as a whole: what the test run leaves
// behind goes in, the Check's Result comes out. The container itself is
// stubbed; the Docker tests cover the real thing.

func selectionWithout(t *testing.T, exclude ...string) *Selection {
	t.Helper()
	sel, err := Resolve(Catalog(), nil, exclude)
	if err != nil {
		t.Fatal(err)
	}
	return sel
}

func TestRuntimeWarningsIsImplementedAndRunsInTheContextsOfTheTests(t *testing.T) {
	e, ok := Lookup(runtimeWarningsID)
	if !ok || e.Status != Implemented || e.CanFireGates {
		t.Fatalf("entry = %+v", e)
	}
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	app, _ := Implementation(runtimeWarningsID).Applicability(in.Project, in.Context)
	if app != resultset.Unknown {
		t.Errorf("applicability = %s, want unknown: the Mocha version is known only after the install", app)
	}
	root := &in.Project.Contexts[0]
	if app, _ := Implementation(runtimeWarningsID).Applicability(in.Project, root); app != resultset.NotApplicable {
		t.Errorf("the project Context has no tests, applicability = %s", app)
	}
}

func TestNodeOptionsGetTheWarningFlagsAfterTheValueFromTheTestCommand(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	in.Selection = selectionWithout(t, "package.manifest")
	env := map[string]string{"NODE_OPTIONS": "--require ./setup.js"}

	marker := in.addWarningsEnv(env)

	want := "--require ./setup.js --trace-warnings --trace-deprecation --pending-deprecation"
	if env["NODE_OPTIONS"] != want {
		t.Errorf("NODE_OPTIONS = %q, want %q", env["NODE_OPTIONS"], want)
	}
	if marker == nil || marker.Grace != 30*time.Second || marker.Text == "" || env["JSPF_END_MARKER"] != marker.Text {
		t.Errorf("marker = %+v, env = %v", marker, env)
	}
}

func TestWithoutAProjectValueNodeOptionsAreJustOurFlags(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	env := map[string]string{}
	in.addWarningsEnv(env)
	if env["NODE_OPTIONS"] != "--trace-warnings --trace-deprecation --pending-deprecation" {
		t.Errorf("NODE_OPTIONS = %q", env["NODE_OPTIONS"])
	}
}

func TestWhenRuntimeWarningsIsNotSelectedNodeOptionsStayAsTheProjectSetThemButTheProcessIsStillWatched(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	in.Selection = selectionWithout(t, runtimeWarningsID)
	env := map[string]string{"NODE_OPTIONS": "--require ./setup.js"}

	marker := in.addWarningsEnv(env)

	if env["NODE_OPTIONS"] != "--require ./setup.js" {
		t.Errorf("NODE_OPTIONS = %q", env["NODE_OPTIONS"])
	}
	if marker == nil || env["JSPF_END_MARKER"] != marker.Text {
		t.Errorf("a suite that keeps its process alive is stopped whatever the Selection: %+v", marker)
	}
}

func TestEveryRunGetsItsOwnEndMarker(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	a, b := in.addWarningsEnv(map[string]string{}), in.addWarningsEnv(map[string]string{})
	if a.Text == b.Text {
		t.Errorf("both runs use %q: the project could guess it", a.Text)
	}
}

// stubSuite replaces the test run with a canned result and counts the runs.
func stubSuite(t *testing.T, res *Result) *atomic.Int32 {
	t.Helper()
	var calls atomic.Int32
	old := runTestSuite
	t.Cleanup(func() { runTestSuite = old })
	runTestSuite = func(context.Context, *Input) *Result {
		calls.Add(1)
		return res
	}
	return &calls
}

func finishedSuite(in *Input, ev *suiteEvents, stderr string, hung bool) *Result {
	return &Result{Status: resultset.StatusCompleted, Command: []string{"node", "x"},
		suite: &suiteRun{Selected: true, Stderr: stderr, Events: ev, Hung: hung, Runner: in.runnerName()}}
}

func TestTestsExistingAndRuntimeWarningsShareOneRunOfTheSuite(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	calls := stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, `{"ev":"end","resources":["TCPServerWrap"]}`)), buffferDeprecation, false))

	tests := testsExisting{}.Run(context.Background(), in)
	warnings := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if calls.Load() != 1 {
		t.Fatalf("the suite ran %d times, want once", calls.Load())
	}
	if tests.Status != resultset.StatusCompleted || warnings.Status != resultset.StatusCompleted {
		t.Errorf("statuses = %s, %s", tests.Status, warnings.Status)
	}
	var rules []string
	for _, f := range warnings.Findings {
		rules = append(rules, ruleOf(f))
		if f.CheckID != runtimeWarningsID || f.Gate {
			t.Errorf("finding %+v", f)
		}
	}
	if strings.Join(rules, ",") != "warning-from-project,open-resources" {
		t.Errorf("rules = %v", rules)
	}
	if len(tests.Findings) != 0 {
		t.Errorf("tests.existing reports no warnings: %+v", tests.Findings)
	}
	if tests == warnings {
		t.Error("the two Checks must not share one Result")
	}
}

func TestTheServicesOfTheSharedRunAreReportedByExactlyOneOfTheTwoChecks(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	run := finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false)
	run.Services = []resultset.Service{{ComposeService: "cache", ContextIDs: []string{in.Context.ID}}}
	stubSuite(t, run)

	both := Implementation(runtimeWarningsID).Run(context.Background(), in)
	in.Selection = selectionWithout(t, testsExistingID, testsCoverageID)
	alone := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if len(both.Services) != 0 || len(alone.Services) != 1 {
		t.Errorf("with both selected %d, with runtime.warnings alone %d Services, want 0 and 1", len(both.Services), len(alone.Services))
	}
}

func TestRuntimeWarningsAloneStillRunsTheSuiteOnce(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	in.Shared = NewShared()
	calls := stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), buffferDeprecation, false))

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if calls.Load() != 1 || len(res.Findings) != 1 {
		t.Errorf("calls = %d, findings = %+v", calls.Load(), res.Findings)
	}
}

func TestAHungSuiteIsStillCompletedAndTheFindingListsTheOpenResources(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, `{"ev":"end","resources":["TCPServerWrap"]}`)), "", true))

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 || ruleOf(res.Findings[0]) != "process-did-not-exit" {
		t.Errorf("result = %+v", res)
	}
}

func TestAHungSuiteWithoutRuntimeWarningsSelectedIsReportedAsALimitationOfTheTests(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	in.Selection = selectionWithout(t, runtimeWarningsID)
	res := &Result{}

	in.recordSuiteRun(res, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), &docker.ContainerResult{StoppedAfterGrace: true})

	var found bool
	for _, l := range res.Limitations {
		found = found || (l.ReasonCode == "process_stopped_after_grace" && *l.CheckID == testsExistingID)
	}
	if !found || res.suite == nil || !res.suite.Hung {
		t.Errorf("limitations = %+v, suite = %+v", res.Limitations, res.suite)
	}
}

func TestWithRuntimeWarningsSelectedTheSuiteResultListsTheNodeOptionsOverride(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	res := &Result{}

	in.recordSuiteRun(res, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), &docker.ContainerResult{})

	if len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "test_command_override" || !strings.Contains(res.Limitations[0].Message, "--trace-warnings") {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestANodeTestSuiteGetsALimitationThatOpenResourcesAreNotCollected(t *testing.T) {
	in := suiteInput(t, map[string]string{"package.json": `{"scripts":{"test":"node --test"}}`, "test/a.test.js": "x"})
	stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false))

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	var got *resultset.Limitation
	for i, l := range res.Limitations {
		if l.ReasonCode == "open_resources_not_collected" {
			got = &res.Limitations[i]
		}
	}
	if got == nil || !strings.Contains(got.Message, "own process") || got.CheckID == nil || *got.CheckID != runtimeWarningsID {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestARunThatTimedOutKeepsTheWarningsItPrintedAndTheStatus(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "src/index.js": "x"})
	run := finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd)), buffferDeprecation, false)
	run.Status, run.ReasonCode, run.Reason = resultset.StatusTimedOut, "timeout", "the Check ran into its time limit"
	stubSuite(t, run)

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if res.Status != resultset.StatusTimedOut || len(res.Findings) != 1 {
		t.Errorf("status = %s, findings = %+v", res.Status, res.Findings)
	}
}

func TestWhenTheSuiteNeverRanBecauseTheRunnerIsMissingRuntimeWarningsHasNothingToReadAndSaysSo(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	stubSuite(t, &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{{}}})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 || len(res.Limitations) == 0 || res.Limitations[0].ReasonCode != "tests_not_run" {
		t.Errorf("result = %+v", res)
	}
}

func TestWhenTheSuiteIsUnsupportedSoIsRuntimeWarnings(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	stubSuite(t, &Result{Status: resultset.StatusUnsupported, ReasonCode: "test_runner_version_unsupported", Reason: "Mocha 8"})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if res.Status != resultset.StatusUnsupported || res.ReasonCode != "test_runner_version_unsupported" {
		t.Errorf("result = %+v", res)
	}
}

func TestWarningsThatTheProjectSwitchesOffAreSaidSoInALimitation(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"env":    {"package.json": `{"scripts":{"test":"NODE_NO_WARNINGS=1 mocha"}}`},
		"option": {"package.json": `{"scripts":{"test":"NODE_OPTIONS=--no-warnings mocha"}}`},
	} {
		files["test/a.test.js"] = "x"
		in := suiteInput(t, files)
		stubSuite(t, finishedSuite(in, parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), "", false))

		res := Implementation(runtimeWarningsID).Run(context.Background(), in)

		var found bool
		for _, l := range res.Limitations {
			found = found || l.ReasonCode == "warnings_suppressed"
		}
		if !found {
			t.Errorf("%s: limitations = %+v", name, res.Limitations)
		}
	}
}
