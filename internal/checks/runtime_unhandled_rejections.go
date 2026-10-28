package checks

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const runtimeUnhandledRejectionsID = "runtime.unhandled-rejections"

func init() { Register(runtimeUnhandledRejectionsID, runtimeUnhandledRejections{}) }

// strictRejectionsFlag is what the strict run adds to NODE_OPTIONS.
const strictRejectionsFlag = "--unhandled-rejections=strict"

// The rules of the Findings of runtime.unhandled-rejections. The Benchmark
// counts both.
const (
	ruleUnhandledRejection      = "unhandled-rejection"
	ruleUnhandledRejectionCrash = "unhandled-rejection-crash"
)

// runtimeUnhandledRejections runs every suite of a package once more with
// --unhandled-rejections=strict and reports the tests that only fail there.
// Mocha registers its own unhandledRejection listener and many projects add one
// that only logs, so a floating promise that rejects during a test never fails
// it; in strict mode Node raises the rejection as an uncaught exception instead.
//
// The strict run is a repeat run (see runRepeat): it starts after the shared
// first run, and after the repeat runs of tests.flaky when that Check is
// selected. A test that passed in the first run and failed, or never ran
// because of a failed hook, in the strict run is a warning Finding without a
// Gate. The tests that tests.flaky reports as flaky are left out, because their
// outcome differs between runs anyway, and counted in explained_by_flakiness.
// Without tests.flaky a Limitation says the differences may be flakiness.
//
// A strict run whose process stops before the run ends, such as for an uncaught
// exception outside any test, is one Finding for the suite, and the tests it
// kept from running are not reported on their own.
type runtimeUnhandledRejections struct{}

func (runtimeUnhandledRejections) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "runtime.unhandled-rejections reruns the test suites of a package, and this is the project Context"
	}
	if c.Package.Tests == nil {
		return resultset.NotApplicable, "the package has no test script and no Mocha config file, so there is no test run to repeat"
	}
	return testRunApplicability(c.Package)
}

// The Check needs what the test run needs, and starts after the first run, which
// it performs itself when nothing else has.
func (runtimeUnhandledRejections) Prerequisites(c *discovery.Context) []string {
	return testsExisting{}.Prerequisites(c)
}

func (runtimeUnhandledRejections) RunsAfter(c *discovery.Context) []string {
	return testsFlaky{}.RunsAfter(c)
}

// OrderedAfter: tests.flaky runs first when it is selected, and the Check reads
// which tests it reported.
func (runtimeUnhandledRejections) OrderedAfter(c *discovery.Context) []string {
	if !(testsExisting{}).runnable(c) {
		return nil
	}
	return []string{testsFlakyID}
}

func (runtimeUnhandledRejections) UsesWorkingCopy() bool { return true }

// UsesServices: the strict run gets the project's test Services of its own.
func (runtimeUnhandledRejections) UsesServices(c *discovery.Context) bool {
	return testsExisting{}.UsesServices(c)
}

func (runtimeUnhandledRejections) Images(c *discovery.Context) []string {
	return testsExisting{}.Images(c)
}

// strictRunNumber is the number of the strict run among the runs of a suite: the
// first run is 1, and tests.flaky makes the next flakyRepeats when it is
// selected.
func (in *Input) strictRunNumber() int {
	if in.Selection == nil || in.Selection.Selected(testsFlakyID) {
		return 2 + flakyRepeats
	}
	return 2
}

func (runtimeUnhandledRejections) Run(ctx context.Context, in *Input) *Result {
	if u := unsupportedTests(in.Context.Package); u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	first := in.sharedSuite(ctx)
	out := &Result{Status: resultset.StatusCompleted}

	var explained flakyTests
	flakyKnown := false
	if in.Shared != nil {
		if v, ok := in.Shared.Get(flakyTestsSharedKey(in.Context.ID)); ok {
			explained, flakyKnown = v.(flakyTests)
		}
	}

	several := suiteCount(in.Context.Package) > 1
	var cut *repeatCut
	var suites []*suiteRuns
	ran, left := 0, 0
	for i, p := range first.perSuite() {
		if p.suite == nil || p.suite.Events == nil || !p.suite.Events.Started {
			continue // the suite never got going, so there is nothing to compare
		}
		bound := in.forSuite(i)
		sr := &suiteRuns{in: bound, name: bound.suite().Origin}
		sr.add(1, p, p.suite.Events, true)
		ran++

		n := in.strictRunNumber()
		res, end := bound.runRepeat(ctx, repeatRun{checkID: runtimeUnhandledRejectionsID, number: n, nodeOptions: strictRejectionsFlag})
		if res == nil {
			res = &Result{Status: resultset.StatusToolError, Reason: "the run returned no result"}
		}
		sr.readServices(runtimeUnhandledRejectionsID, p, []*Result{res})
		suites = append(suites, sr)
		out.Artifacts = append(out.Artifacts, res.Artifacts...)
		if out.Command == nil {
			out.Command, out.Tool = res.Command, res.Tool
		}
		var ev *suiteEvents
		if res.suite != nil {
			ev = res.suite.Events
		}

		// An uncaught exception outside any test ends the run early: the process
		// stops, or the runner records the error and ends the run. The tests it
		// kept from running belong to its one Finding. A problem that the first
		// run had too is no work of the flag, and tests.existing reports it.
		crash := findStrictCrash(p.suite.Events, ev, res, end)
		if crash != nil && crash.byFlag {
			out.Findings = append(out.Findings, sr.crashFinding(crash, several))
		}
		if ev != nil && ev.Started {
			sr.add(n, res, ev, end == repeatDone)
		}
		if crash == nil {
			if c := repeatProblem(sr.name, n, res, ev, end); c != nil && cut == nil {
				cut = c
			}
		}
		fs, skipped := sr.rejectionFindings(crash != nil, explained, several)
		out.Findings = append(out.Findings, fs...)
		left += skipped
		if end == repeatBudget || end == repeatCancelled {
			break
		}
	}

	if ran == 0 {
		// No suite ran far enough to compare. The first run says why.
		if first.Status != resultset.StatusCompleted {
			return &Result{Status: first.Status, ReasonCode: first.ReasonCode, Reason: first.Reason}
		}
		id := runtimeUnhandledRejectionsID
		out.Limitations = []resultset.Limitation{{
			ReasonCode: "tests_not_run", CheckID: &id,
			Message: "The test suite did not run, so there is nothing to compare the strict run with. tests.existing says why.",
		}}
		return out
	}

	out.Limitations = append(out.Limitations, serviceLimitations(suites)...)
	if !flakyKnown {
		id, manifest := runtimeUnhandledRejectionsID, in.manifestPath()
		why := "tests.flaky is not selected"
		if in.Selection == nil || in.Selection.Selected(testsFlakyID) {
			why = "tests.flaky did not report for this package"
		}
		out.Limitations = append(out.Limitations, resultset.Limitation{
			ReasonCode: "flakiness_not_excluded", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("%s, so a test that fails in the strict run may be flaky and not affected by the flag. Run tests.flaky as well to leave out the tests that differ between runs anyway.", capitalize(why)),
		})
	}
	count := float64(left)
	out.Metrics = []resultset.Metric{{Name: "explained_by_flakiness", Value: &count, Unit: "tests"}}
	if cut != nil {
		out.Status, out.ReasonCode, out.Reason = resultset.StatusPartial, cut.code, cut.reason
		out.KeepsStatus = cut.end != repeatCancelled
	}
	return out
}

// rejectionFindings turns the first run and the strict run of the suite into
// Findings, and counts the tests it left out because tests.flaky explains them.
// crashed says that the strict run's process stopped, which makes its never-run
// tests part of the crash Finding.
func (s *suiteRuns) rejectionFindings(crashed bool, explained flakyTests, qualify bool) (out []resultset.Finding, left int) {
	if len(s.runs) < 2 {
		return nil, 0 // the strict run produced no events
	}
	first, strict := s.runs[0], s.runs[1]
	for _, key := range s.orderedKeys() {
		before, after := s.observe(first, key), s.observe(strict, key)
		if !before.found || before.unknown || before.outcome != resultset.TestPassed {
			continue
		}
		if !after.found || after.unknown {
			continue
		}
		switch after.outcome {
		case resultset.TestFailed:
		case resultset.TestNeverRun:
			if crashed {
				continue
			}
		default:
			continue
		}
		if explained[testKeyInSuite(s.name, key)] {
			left++
			continue
		}
		out = append(out, s.rejectionFinding(after, qualify))
	}
	return out, left
}

func (s *suiteRuns) rejectionFinding(after observation, qualify bool) resultset.Finding {
	in := s.in
	rec := after.rec
	file, title := in.testFile(rec.File), rec.FullTitle
	rule := ruleUnhandledRejection

	what := "failed"
	if after.outcome == resultset.TestNeverRun {
		what = "never ran because of a failed hook"
	}
	at := frame{Path: file}
	if rec.Err != nil {
		if f := locate(in.projectFrames(rec.Err.Stack), file); f.Path == file {
			at = f
		}
	}
	f := resultset.Finding{
		CheckID: runtimeUnhandledRejectionsID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(runtimeUnhandledRejectionsID, rule, file, title),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning, Confidence: resultset.ConfidenceLikely,
		Title: "Test fails with strict unhandled rejections: " + oneLine(resultset.WithoutControls(title), 200),
		Message: fmt.Sprintf("The test %s passed in the normal run and %s with %s. The normal run hides a promise that rejects without a handler, such as one that is neither awaited nor returned, and the strict run turns it into an error. Await the promise, return it or give it a catch handler, then run the test again.",
			resultset.Quote(shorten(title, 200)), what, strictRejectionsFlag),
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Reproduction: in.Reproduction(runtimeUnhandledRejectionsID),
		Limitations:  []string{},
	}
	switch {
	case after.outcome == resultset.TestNeverRun:
		text := "never run in the strict run"
		if rec.NeverRunReason != "" {
			text += ": " + rec.NeverRunReason
		}
		f.Evidence = []resultset.Evidence{Untrusted("test_run", text, in.runnerName())}
	case rec.Err != nil:
		f.Evidence = errorEvidence(rec.Err, in.runnerName())
	}
	f.Reproduction.Test = &resultset.TestRepro{
		Runner: in.runnerName(), File: file, FullTitle: title,
		NativeCommand: strictNativeCommand(in.nativeTestCommand(in.nativeBaseOfSuite(), file, &title)),
	}
	s.attachSuite(&f, qualify)
	return f
}

// mochaOutsideSuite is the title Mocha gives the failure of an uncaught error
// that no test or hook was running for.
const mochaOutsideSuite = "Uncaught error outside test suite"

// strictCrash is an uncaught exception outside any test that cut the strict run
// short.
type strictCrash struct {
	// err is the error the runner recorded for it, nil when it recorded none.
	err *testErr
	// text is what the process or the test file's process printed.
	text string
	// exit is the exit code of a process that stopped, nil when not known.
	exit *int
	// byFlag is false when the first run was cut short the same way, so that the
	// flag is not the cause.
	byFlag bool
}

// findStrictCrash looks for the uncaught exception outside any test that ended
// the strict run early: the failure that Mocha records for an error outside the
// suite, a test file whose process stopped (node:test), or a process that
// stopped before the run ended. It returns nil when the strict run went through,
// or ended for another reason such as its time limit.
func findStrictCrash(first, ev *suiteEvents, res *Result, end repeatEnd) *strictCrash {
	if end != repeatDone || ev == nil {
		return nil
	}
	for _, t := range ev.Tests {
		if t.Outcome != resultset.TestFailed || t.Title != mochaOutsideSuite || t.Err == nil {
			continue
		}
		hadIt := slices.ContainsFunc(first.Tests, func(f *testRecord) bool {
			return f.Title == mochaOutsideSuite && f.Err != nil && f.Err.Message == t.Err.Message
		})
		if !hadIt {
			return &strictCrash{err: t.Err, byFlag: true}
		}
	}
	for _, f := range ev.Files {
		if !slices.ContainsFunc(first.Files, func(g fileFailure) bool { return g.File == f.File }) {
			return &strictCrash{err: &f.Err, text: f.Text, byFlag: true}
		}
	}
	if res.Status == resultset.StatusCompleted && !ev.Ended {
		c := &strictCrash{text: res.suite.Stderr, byFlag: first.Ended}
		if res.Tool != nil {
			c.exit = res.Tool.ExitCode
		}
		return c
	}
	return nil
}

// crashFinding is the one Finding of a strict run that an uncaught exception
// outside any test ended early.
func (s *suiteRuns) crashFinding(c *strictCrash, qualify bool) resultset.Finding {
	in := s.in
	rule := ruleUnhandledRejectionCrash
	var stack, first string
	if c.err != nil {
		stack, first = c.err.Stack, c.err.text()
	}
	if first == "" {
		first = firstErrorLine(c.text)
	}
	at := locate(in.projectFrames(stack+"\n"+c.text), in.manifestPath())
	exit := ""
	if c.exit != nil {
		exit = fmt.Sprintf(" The process exited with code %d.", *c.exit)
	}
	f := resultset.Finding{
		CheckID: runtimeUnhandledRejectionsID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(runtimeUnhandledRejectionsID, rule, at.Path, first),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning, Confidence: resultset.ConfidenceLikely,
		Title: "The strict run ends early on an uncaught exception",
		Message: fmt.Sprintf("With %s the run of the suite %s ended early on an uncaught exception outside any test, while the normal run went through.%s The usual cause is a promise that rejects without a handler outside any test, which Node raises as an uncaught exception in strict mode. The tests that never ran in the strict run are not reported on their own. The error is in the Evidence.",
			strictRejectionsFlag, resultset.Quote(s.name), exit),
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Reproduction: in.Reproduction(runtimeUnhandledRejectionsID),
		Limitations:  []string{},
	}
	switch {
	case c.err != nil:
		f.Evidence = errorEvidence(c.err, in.runnerName())
	case strings.TrimSpace(c.text) != "":
		f.Evidence = []resultset.Evidence{Untrusted("tool_output", relativeStack(tail(strings.TrimSpace(c.text), 6000)), in.runnerName())}
	}
	s.attachSuite(&f, qualify)
	return f
}

// strictNativeCommand puts the flag into the environment of the project's own
// command for one test, which starts with `env K=V …` when the test command
// sets variables. An existing NODE_OPTIONS gets the flag after its value.
func strictNativeCommand(cmd []string) []string {
	const name = "NODE_OPTIONS="
	if len(cmd) > 0 && cmd[0] == "env" {
		out := slices.Clone(cmd)
		i := 1
		for ; i < len(out) && isEnvAssignment(out[i]); i++ {
			if strings.HasPrefix(out[i], name) {
				out[i] += " " + strictRejectionsFlag
				return out
			}
		}
		return slices.Insert(out, 1, name+strictRejectionsFlag)
	}
	return append([]string{"env", name + strictRejectionsFlag}, cmd...)
}

// isEnvAssignment says whether an argument of env is NAME=value.
func isEnvAssignment(arg string) bool {
	eq := strings.IndexByte(arg, '=')
	if eq <= 0 {
		return false
	}
	for _, r := range arg[:eq] {
		if !(r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}
