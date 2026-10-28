package checks

import (
	"context"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const testsFlakyID = "tests.flaky"

func init() { Register(testsFlakyID, testsFlaky{}) }

// flakyRepeats is how many more times each suite runs after the shared first
// run.
const flakyRepeats = 2

// The rules of the Findings of tests.flaky. The Benchmark counts the first.
const (
	ruleFlakyTest      = "flaky-test"
	ruleTestInSomeRuns = "test-in-some-runs"
)

// maxRunNotes caps the notes for tests that only some runs found. A project
// that generates its tests at load time can have thousands.
const maxRunNotes = 50

// testsFlaky runs every suite of a package two more times after the shared first
// run (see sharedSuite) and reports the tests whose outcome differs between
// the runs, and the tests that only passed after Mocha's own retries. The
// repeat runs are made like the first run, in the same Working copy, one after
// another, each with fresh Services on a network of its own (see runRepeat).
//
// A test is identified by its file and full title. It is flaky when its final
// outcome is passed in one run and failed, or never run because a hook failed,
// in another. Skipped and todo tests take part in no comparison, and a test
// that only some runs found is a note, not a Flaky test. Every Flaky test is a
// warning Finding without a Gate: a test that fails in every run is a failed
// test, which tests.existing reports.
//
// When a repeat run times out or the Budget ends, the comparisons that finished
// are reported and the execution is partial.
type testsFlaky struct{}

func (testsFlaky) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "tests.flaky repeats the test runs of a package, and this is the project Context"
	}
	if c.Package.Tests == nil {
		return resultset.NotApplicable, "the package has no test script and no Mocha config file, so there is no test run to repeat"
	}
	return testRunApplicability(c.Package)
}

// The Check needs what the test run needs, and starts after the first run, which
// it performs itself when nothing else has.
func (testsFlaky) Prerequisites(c *discovery.Context) []string {
	return testsExisting{}.Prerequisites(c)
}

// RunsAfter: the first run is made by tests.existing, even when the Selection
// leaves that Check out, so the repeat runs are scheduled right after it.
func (testsFlaky) RunsAfter(c *discovery.Context) []string {
	if !(testsExisting{}).runnable(c) {
		return nil
	}
	return []string{testsExistingID}
}

func (testsFlaky) UsesWorkingCopy() bool { return true }

// UsesServices: every repeat run gets the project's test Services of its own.
func (testsFlaky) UsesServices(c *discovery.Context) bool { return testsExisting{}.UsesServices(c) }

func (testsFlaky) Images(c *discovery.Context) []string { return testsExisting{}.Images(c) }

func (testsFlaky) Run(ctx context.Context, in *Input) *Result {
	if u := unsupportedTests(in.Context.Package); u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	first := in.sharedSuite(ctx)
	out := &Result{Status: resultset.StatusCompleted}

	var suites []*suiteRuns
	var cut *repeatCut
	parts := first.perSuite()
	for i, p := range parts {
		if p.suite == nil || p.suite.Events == nil || !p.suite.Events.Started {
			continue // the suite never got going, so there is nothing to repeat
		}
		bound := in.forSuite(i)
		sr := &suiteRuns{in: bound, name: bound.suite().Origin}
		sr.add(1, p, p.suite.Events, true)
		suites = append(suites, sr)
		var own []*Result
		stop := false
		for n := 2; n <= 1+flakyRepeats && !stop; n++ {
			res, end := bound.runRepeat(ctx, repeatRun{checkID: testsFlakyID, number: n})
			if res == nil {
				res = &Result{Status: resultset.StatusToolError, Reason: "the run returned no result"}
			}
			own = append(own, res)
			out.Artifacts = append(out.Artifacts, res.Artifacts...)
			if out.Command == nil {
				out.Command, out.Tool = res.Command, res.Tool
			}
			ev := (*suiteEvents)(nil)
			if res.suite != nil {
				ev = res.suite.Events
			}
			if ev != nil && ev.Started {
				sr.add(n, res, ev, end == repeatDone)
			}
			if c := repeatProblem(sr.name, n, res, ev, end); c != nil && cut == nil {
				cut = c
			}
			stop = end == repeatBudget || end == repeatCancelled
		}
		sr.readServices(testsFlakyID, p, own)
		if stop {
			break
		}
	}

	if len(suites) == 0 {
		// No suite ran far enough to repeat. The first run says why.
		if first.Status != resultset.StatusCompleted {
			return &Result{Status: first.Status, ReasonCode: first.ReasonCode, Reason: first.Reason}
		}
		id := testsFlakyID
		out.Limitations = []resultset.Limitation{{
			ReasonCode: "tests_not_run", CheckID: &id,
			Message: "The test suite did not run, so there is nothing to repeat. tests.existing says why.",
		}}
		return out
	}

	several := suiteCount(in.Context.Package) > 1
	flaky, notes := 0, 0
	var omitted int
	explained := flakyTests{}
	for _, sr := range suites {
		fs, ns := sr.compare(several)
		for key := range sr.flakyKeys {
			explained[testKeyInSuite(sr.name, key)] = true
		}
		for _, f := range fs {
			flaky++
			out.Findings = append(out.Findings, f)
		}
		for _, f := range ns {
			if notes >= maxRunNotes {
				omitted++
				continue
			}
			notes++
			out.Findings = append(out.Findings, f)
		}
	}
	out.Limitations = append(out.Limitations, serviceLimitations(suites)...)
	if omitted > 0 {
		id, manifest := testsFlakyID, in.manifestPath()
		out.Limitations = append(out.Limitations, resultset.Limitation{
			ReasonCode: "notes_truncated", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("%d more tests were found in only some runs than the %d that are reported as notes.", omitted, maxRunNotes),
		})
	}
	if in.Shared != nil {
		// runtime.unhandled-rejections leaves out the tests reported here.
		in.Shared.Put(flakyTestsSharedKey(in.Context.ID), explained)
	}
	count := float64(flaky)
	out.Metrics = []resultset.Metric{{Name: "flaky_tests", Value: &count, Unit: "tests"}}
	if cut != nil {
		out.Status, out.ReasonCode, out.Reason = resultset.StatusPartial, cut.code, cut.reason
		out.KeepsStatus = cut.end != repeatCancelled
	}
	return out
}

// repeatCut says why a repeat run did not give what it should, which makes the
// execution partial.
type repeatCut struct {
	code, reason string
	end          repeatEnd
}

// repeatProblem says what was wrong with a repeat run, or returns nil for a run
// that went as it should.
func repeatProblem(suite string, n int, res *Result, ev *suiteEvents, end repeatEnd) *repeatCut {
	which := fmt.Sprintf("Run %d of the suite %s", n, resultset.Quote(suite))
	switch end {
	case repeatTimedOut:
		return &repeatCut{"repeat_run_timed_out", fmt.Sprintf("%s ran into its time limit of %s. The comparisons that finished are reported.", which, repeatRunTimeout), end}
	case repeatBudget:
		return &repeatCut{"budget_exhausted", fmt.Sprintf("The Budget ran out during %s. The comparisons that finished are reported.", strings.ToLower(which[:1])+which[1:]), end}
	case repeatCancelled:
		return &repeatCut{"cancelled", "the Run was cancelled", end}
	}
	switch {
	case ev == nil || !ev.Started:
		why := res.Reason
		if why == "" {
			why = "the runner stopped before it ran any test"
		}
		return &repeatCut{"repeat_run_failed", fmt.Sprintf("%s did not run: %s", which, why), end}
	case !ranToTheEnd(res, ev):
		return &repeatCut{"repeat_run_failed", fmt.Sprintf("%s did not finish: %s", which, res.Reason), end}
	}
	return nil
}

// --- comparing the runs of one suite ---

// compare finds the Flaky tests and the tests that only some runs found.
func (s *suiteRuns) compare(qualify bool) (flaky, notes []resultset.Finding) {
	if len(s.runs) < 2 {
		return nil, nil // a suite whose repeats did not run has nothing to compare
	}
	for _, key := range s.orderedKeys() {
		obs := make([]observation, len(s.runs))
		var inRuns, notIn []int
		for i, r := range s.runs {
			obs[i] = s.observe(r, key)
			switch {
			case obs[i].found:
				inRuns = append(inRuns, r.number)
			case !obs[i].unknown:
				notIn = append(notIn, r.number)
			}
		}
		if len(notIn) > 0 && len(inRuns) > 0 {
			notes = append(notes, s.noteFinding(obs, inRuns, notIn, qualify))
			continue
		}
		if s.isFlaky(obs) {
			flaky = append(flaky, s.flakyFinding(obs, qualify))
			if s.flakyKeys == nil {
				s.flakyKeys = map[string]bool{}
			}
			s.flakyKeys[key] = true
		}
	}
	return flaky, notes
}

// isFlaky applies the rule: a pass in one run and a failure in another, where
// a test that never ran because a hook failed counts as failed, or a pass that
// needed Mocha's retries in any run.
func (s *suiteRuns) isFlaky(obs []observation) bool {
	passed, failed := false, false
	for _, o := range obs {
		switch o.outcome {
		case resultset.TestPassed:
			passed = true
			if o.rec != nil && len(o.rec.Attempts) > 0 {
				return true
			}
		case resultset.TestFailed, resultset.TestNeverRun:
			failed = true
		}
	}
	return passed && failed
}

// outcomeWords describes an outcome the way a title and the Evidence do.
func outcomeWords(o observation) string {
	switch {
	case !o.found && o.unknown:
		return "no result"
	case !o.found:
		return "not found"
	case o.unknown:
		return "no result"
	}
	switch o.outcome {
	case resultset.TestNeverRun:
		return "never run"
	case resultset.TestPassed, resultset.TestFailed:
		if n := len(o.rec.Attempts); n > 0 {
			return fmt.Sprintf("%s after %d attempts", o.outcome, n+1)
		}
	}
	return string(o.outcome)
}

// runEvidence is the outcome, attempts and error of one run of a test.
func runEvidence(number int, o observation) string {
	head := fmt.Sprintf("run %d", number)
	if number == 1 {
		head += " (first run)"
	}
	if !o.found || o.unknown {
		return head + ": " + outcomeWords(o)
	}
	switch o.outcome {
	case resultset.TestNeverRun:
		text := head + ": never run"
		if o.rec.NeverRunReason != "" {
			text += ": " + o.rec.NeverRunReason
		}
		return text
	case resultset.TestPassed, resultset.TestFailed:
	default:
		return head + ": " + string(o.outcome)
	}
	text := head + ": " + outcomeWords(o)
	total := len(o.rec.Attempts) + 1
	if o.outcome == resultset.TestPassed && total == 1 {
		return text
	}
	for i, a := range o.rec.Attempts {
		text += fmt.Sprintf("\n  attempt %d: %s", i+1, attemptText(a.Outcome, a.Error))
	}
	text += fmt.Sprintf("\n  attempt %d (final): %s", total, attemptText(o.outcome, errorText(o.rec.Err)))
	return text
}

func attemptText(outcome resultset.TestOutcome, err *string) string {
	if err == nil || strings.TrimSpace(*err) == "" {
		return string(outcome)
	}
	return string(outcome) + ": " + oneLine(relativeStack(*err), 400)
}

// testIdentity is the file and full title of the test of a key.
func (s *suiteRuns) testIdentity(obs []observation) (file, fullTitle string, rec *testRecord) {
	for _, o := range obs {
		if o.rec != nil {
			return s.in.testFile(o.rec.File), o.rec.FullTitle, o.rec
		}
	}
	return "", "", nil
}

func (s *suiteRuns) flakyFinding(obs []observation, qualify bool) resultset.Finding {
	in := s.in
	file, title, _ := s.testIdentity(obs)
	rule := ruleFlakyTest

	var words, evidence []string
	var passedIn, failedIn, retried []string
	var failing *testErr
	for i, o := range obs {
		n := s.runs[i].number
		words = append(words, outcomeWords(o))
		evidence = append(evidence, runEvidence(n, o))
		switch o.outcome {
		case resultset.TestPassed:
			passedIn = append(passedIn, fmt.Sprint(n))
			if len(o.rec.Attempts) > 0 {
				retried = append(retried, fmt.Sprint(n))
			}
		case resultset.TestFailed, resultset.TestNeverRun:
			failedIn = append(failedIn, fmt.Sprint(n))
			if o.outcome == resultset.TestFailed && failing == nil {
				failing = o.rec.Err
			}
		}
	}

	var message string
	if len(failedIn) > 0 {
		message = fmt.Sprintf("The test %s passed in run %s and failed, or never ran because of a failed hook, in run %s, of %d runs of the same Snapshot. ",
			resultset.Quote(shorten(title, 200)), strings.Join(passedIn, ", "), strings.Join(failedIn, ", "), len(obs))
	} else {
		message = fmt.Sprintf("The test %s only passed after Mocha retried it, in run %s. ", resultset.Quote(shorten(title, 200)), strings.Join(retried, ", "))
	}
	message += "Every run used the same Working copy and fresh Services, so the cause is in the test or in what it reads from outside, such as the clock, timers, random values, the order of files or leftovers in its own package folder. Find what differs between the runs before you change the code under test."

	at := frame{Path: file}
	if failing != nil {
		if f := locate(in.projectFrames(failing.Stack), file); f.Path == file {
			at = f
		}
	}
	f := resultset.Finding{
		CheckID: testsFlakyID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsFlakyID, rule, file, title),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning, Confidence: resultset.ConfidenceConfirmed,
		Title:        shorten(fmt.Sprintf("Flaky test: %s (runs: %s)", shorten(oneLine(title, 100), 100), strings.Join(words, ", ")), 200),
		Message:      message,
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Reproduction: in.Reproduction(testsFlakyID),
		Limitations:  []string{},
	}
	for _, text := range evidence {
		f.Evidence = append(f.Evidence, Untrusted("test_run", text, in.runnerName()))
	}
	f.Reproduction.Test = &resultset.TestRepro{
		Runner: in.runnerName(), File: file, FullTitle: title,
		NativeCommand: in.nativeTestCommand(in.nativeBaseOfSuite(), file, &title),
	}
	s.attachSuite(&f, qualify)
	return f
}

// noteFinding is the note for a test that some runs found and others did not.
// Tests generated at load time can differ this way, so it is no Flaky test.
func (s *suiteRuns) noteFinding(obs []observation, inRuns, notIn []int, qualify bool) resultset.Finding {
	in := s.in
	file, title, _ := s.testIdentity(obs)
	rule := ruleTestInSomeRuns
	runNumbers := func(ns []int) string {
		parts := make([]string, len(ns))
		for i, n := range ns {
			parts[i] = fmt.Sprint(n)
		}
		return strings.Join(parts, ", ")
	}
	f := resultset.Finding{
		CheckID: testsFlakyID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsFlakyID, rule, file, title),
		Kind:        resultset.KindHint, Severity: resultset.SeverityNote, Confidence: resultset.ConfidenceConfirmed,
		Title: shorten("Test found in only some runs: "+shorten(oneLine(title, 100), 100), 200),
		Message: fmt.Sprintf("The test %s was found in run %s but not in run %s of the same Snapshot. Tests that a file generates when it loads can differ between runs, so it is not reported as a Flaky test and its outcomes are not compared.",
			resultset.Quote(shorten(title, 200)), runNumbers(inRuns), runNumbers(notIn)),
		Locations:    []resultset.Location{in.Location("primary", file, 0, 0)},
		Reproduction: in.Reproduction(testsFlakyID),
		Limitations:  []string{},
	}
	s.attachSuite(&f, qualify)
	return f
}

// nativeBaseOfSuite is the start of the command that re-runs one test of the
// suite with the project's own tools, as the first run reports it.
func (in *Input) nativeBaseOfSuite() []string {
	tc := in.suite()
	if tc.Runner == discovery.RunnerNodeTest {
		return nodeTestNativeBase(tc, planNodeTestArgs(tc.Args, nodeTestReporterPath))
	}
	return nativeBase(tc, planMochaArgs(tc.Args, reporterPath))
}
