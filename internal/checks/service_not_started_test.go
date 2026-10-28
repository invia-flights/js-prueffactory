package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A suite whose tests need a compose Service the Run did not start is marked,
// not blamed on the project: its failures are not Gates, they carry a note,
// the Gaps say why, and the Pass rate is not measured (tests.existing is
// partial). A suite is marked by a static reference in env files or Test code,
// or by a failing test whose Evidence shows a lookup or connection error for
// the Service's name.

const minioCompose = `services:
  redis:
    image: valkey/valkey:8.1-alpine
  minio:
    image: quay.io/minio/minio:latest
`

const (
	lookupMessage = `getaddrinfo EAI_AGAIN minio`
	failedLookup  = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"Error","message":"getaddrinfo EAI_AGAIN minio","stack":"Error: getaddrinfo EAI_AGAIN minio\n    at GetAddrInfoReqWrap.onlookup [as oncomplete] (node:dns:120:26)"}}`
	failedOther   = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"AssertionError","message":"5 !== 6","stack":"AssertionError: 5 !== 6\n    at Context.<anonymous> (/work/test/add.test.js:9:12)"}}`
)

// serviceInput is a package with a compose file whose minio entry is not
// started, and the given further files.
func serviceInput(t *testing.T, files map[string]string) *Input {
	t.Helper()
	files["docker-compose.yml"] = minioCompose
	in := suiteInput(t, files)
	in.Shared = NewShared()
	return in
}

// suiteRun is the result a suite run gives for the events: test cases,
// Findings and counts, as launchSuite builds them.
func suiteRunOf(in *Input, events ...string) *Result {
	r := in.suiteResults(parseTestEvents(lines(events...)), mochaNative)
	return &Result{Status: resultset.StatusCompleted, Findings: r.Findings, TestCases: r.TestCases,
		Inventory: &resultset.Inventory{Tests: []resultset.PackageTests{r.Inventory}, TestFiles: r.Files}}
}

func TestAFailureInASuiteThatRefersToAServiceThatIsNotStartedIsNoGate(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "PORT=1\nHOST=http://minio:9000/x\n",
	})
	stubSuite(t, suiteRunOf(in, foundAdd, foundSub, passedAdd, failedOther, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	f := res.Findings[0]
	if f.Gate || f.Confidence != resultset.ConfidenceSuspected {
		t.Errorf("gate = %v, confidence = %s; want no Gate and suspected", f.Gate, f.Confidence)
	}
	if !strings.Contains(f.Message, "minio") || !strings.Contains(f.Message, "not start") {
		t.Errorf("the Finding names no missing Service: %q", f.Message)
	}
	if len(f.Limitations) != 1 || f.Limitations[0] != "service_not_started" {
		t.Errorf("finding limitations = %v", f.Limitations)
	}
	if res.Status != resultset.StatusPartial || res.ReasonCode != "service_not_started" || !strings.Contains(res.Reason, "minio") {
		t.Errorf("status = %s / %s / %q", res.Status, res.ReasonCode, res.Reason)
	}
	got := limitationsOfCode(res, "service_not_started")
	if len(got) != 1 {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	l := got[0]
	if l.Path == nil || *l.Path != "test/.test.env" || l.CheckID == nil || *l.CheckID != "tests.existing" {
		t.Errorf("limitation = %+v", l)
	}
	for _, want := range []string{"minio", "line 2", "scripts.test", "heuristic", "only official Docker Hub images are started"} {
		if !strings.Contains(l.Message, want) {
			t.Errorf("message lacks %q: %s", want, l.Message)
		}
	}
}

func TestASuiteThatRefersToAServiceThatIsNotStartedIsMarkedEvenWhenAllItsTestsPass(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	stubSuite(t, suiteRunOf(in, foundAdd, passedAdd, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "service_not_started" {
		t.Errorf("status = %s / %s", res.Status, res.ReasonCode)
	}
	if len(limitationsOfCode(res, "service_not_started")) != 1 {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestAFailedHookOfAnAffectedSuiteIsNoGateEither(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	hook := `{"ev":"hook_fail","title":"\"before all\" hook in \"add\"","hookType":"before all","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"boom","stack":"Error: boom"}}`
	stubSuite(t, suiteRunOf(in, foundAdd, hook, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 || res.Findings[0].Gate || res.Findings[0].Confidence != resultset.ConfidenceSuspected ||
		!strings.Contains(res.Findings[0].Message, "minio") {
		t.Fatalf("findings = %+v", res.Findings)
	}
}

func TestAPackageWithoutAReferenceKeepsItsGates(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	stubSuite(t, suiteRunOf(in, foundAdd, foundSub, passedAdd, failedOther, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 || !res.Findings[0].Gate || res.Findings[0].Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("findings = %+v", res.Findings)
	}
	if res.Status != resultset.StatusCompleted || len(limitationsOfCode(res, "service_not_started")) != 0 {
		t.Errorf("status = %s, limitations = %+v", res.Status, res.Limitations)
	}
}

func TestAFailingTestWhoseEvidenceShowsALookupErrorForTheServiceMarksItsSuite(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	stubSuite(t, suiteRunOf(in, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	f := res.Findings[0]
	if f.Gate || f.Confidence != resultset.ConfidenceSuspected || !strings.Contains(f.Message, "minio") {
		t.Errorf("finding = %+v", f)
	}
	if res.Status != resultset.StatusPartial || res.ReasonCode != "service_not_started" {
		t.Errorf("status = %s / %s", res.Status, res.ReasonCode)
	}
	got := limitationsOfCode(res, "service_not_started")
	if len(got) != 1 || !strings.Contains(got[0].Message, "EAI_AGAIN") {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	if got[0].Path == nil || *got[0].Path != "package.json" {
		t.Errorf("a runtime mark points at the manifest: %+v", got[0].Path)
	}
}

func TestALookupErrorForAnotherHostMarksNothing(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	other := strings.ReplaceAll(failedLookup, "minio", "minio.example.com")
	stubSuite(t, suiteRunOf(in, foundAdd, foundSub, passedAdd, other, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if !res.Findings[0].Gate || res.Status != resultset.StatusCompleted {
		t.Errorf("finding = %+v, status = %s", res.Findings[0], res.Status)
	}
}

func TestALookupErrorForAServiceTheRunStartedMarksNothing(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	other := strings.ReplaceAll(failedLookup, "minio", "redis")
	stubSuite(t, suiteRunOf(in, foundAdd, foundSub, passedAdd, other, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if !res.Findings[0].Gate || res.Status != resultset.StatusCompleted {
		t.Errorf("finding = %+v, status = %s", res.Findings[0], res.Status)
	}
}

func TestARuntimeMarkAffectsOnlyTheSuiteWhoseTestFailed(t *testing.T) {
	in := twoSuiteInput(t)
	in.Context.Package.ServiceRefs = nil
	in.Project.Services = []discovery.ComposeService{{Name: "minio", File: "docker-compose.yml", Declared: "quay.io/minio/minio",
		NotStarted: &discovery.Unsupported{Code: "unknown_image", Reason: "the image belongs to no known test Service family"}}}
	stubSuites(t, func(in *Input, ran int) *Result {
		if ran == 0 {
			return suiteRunOf(in, foundAdd, foundSub, passedAdd, failedOther, endOfSuite)
		}
		return suiteRunOf(in, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite)
	})

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if !res.Findings[0].Gate {
		t.Errorf("the unaffected suite keeps its Gate: %+v", res.Findings[0])
	}
	if res.Findings[1].Gate || res.Findings[1].Confidence != resultset.ConfidenceSuspected {
		t.Errorf("the affected suite's failure is no Gate: %+v", res.Findings[1])
	}
	got := limitationsOfCode(res, "service_not_started")
	if len(got) != 1 || !strings.Contains(got[0].Message, "test:api") {
		t.Fatalf("one Limitation for the affected suite only: %+v", res.Limitations)
	}
	if res.Status != resultset.StatusPartial || res.ReasonCode != "service_not_started" || !strings.Contains(res.Reason, "test:api") {
		t.Errorf("status = %s / %s / %q", res.Status, res.ReasonCode, res.Reason)
	}
}

func TestAStaticReferenceMarksEverySuiteOfThePackageWithALimitationEach(t *testing.T) {
	in := twoSuiteInput(t)
	in.Project.Services = []discovery.ComposeService{{Name: "minio", File: "docker-compose.yml", Declared: "quay.io/minio/minio",
		NotStarted: &discovery.Unsupported{Code: "unknown_image", Reason: "the image belongs to no known test Service family"}}}
	in.Context.Package.ServiceRefs = []discovery.ServiceRef{{Service: "minio", File: "test/.test.env", Line: 3}}
	stubSuites(t, func(in *Input, _ int) *Result {
		return suiteRunOf(in, foundAdd, passedAdd, endOfSuite)
	})

	res := testsExisting{}.Run(context.Background(), in)

	got := limitationsOfCode(res, "service_not_started")
	if len(got) != 2 {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	if !strings.Contains(got[0].Message, "test:unit") || !strings.Contains(got[1].Message, "test:api") {
		t.Errorf("messages = %q / %q", got[0].Message, got[1].Message)
	}
}

func TestALoadFailureWithALookupErrorInAnAffectedSuiteIsNoGateButOtherLoadFailuresAre(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	lookup := `{"ev":"file_fail","file":"/work/test/add.test.js","text":"Error: getaddrinfo ENOTFOUND other-host\n    at /work/test/add.test.js:1:1"}`
	syntax := `{"ev":"file_fail","file":"/work/test/b.test.js","text":"SyntaxError: Unexpected token"}`
	stubSuite(t, suiteRunOf(in, lookup, syntax, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		isLookup := strings.Contains(f.Title, "add.test.js")
		if f.Gate == isLookup {
			t.Errorf("finding %q has gate = %v", f.Title, f.Gate)
		}
	}
}

// A setup file that fetches from the Service and throws a plain Error shows no
// lookup code (the project's own error hides it), but the suite refers to the
// Service by name, so the failure is not blamed on the project. A defect of the
// code itself still is a Gate.
func TestALoadFailureWithoutALookupCodeInAStaticallyMarkedSuiteIsNoGateUnlessItIsACodeDefect(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	setup := `{"ev":"file_fail","file":"/work/test/setup.js","text":"Error: The cache fill of the test setup failed:\nCache update step failed: step=translations\n    at fillCaches (/work/test/setup.js:68:15)"}`
	syntax := `{"ev":"file_fail","file":"/work/test/b.test.js","text":"SyntaxError: Unexpected token"}`
	missing := `{"ev":"file_fail","file":"/work/test/c.test.js","text":"Error: Cannot find module './nope'\nRequire stack:\n- /work/test/c.test.js"}`
	stubSuite(t, suiteRunOf(in, setup, syntax, missing, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 3 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		isSetup := strings.Contains(f.Title, "setup.js")
		if f.Gate == isSetup {
			t.Errorf("finding %q has gate = %v", f.Title, f.Gate)
		}
	}
}

func TestALoadFailureWithoutALookupCodeInAPackageWithoutAReferenceKeepsItsGate(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	setup := `{"ev":"file_fail","file":"/work/test/setup.js","text":"Error: The cache fill of the test setup failed"}`
	stubSuite(t, suiteRunOf(in, setup, endOfSuite))

	res := testsExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 || !res.Findings[0].Gate {
		t.Fatalf("findings = %+v", res.Findings)
	}
}

// The Findings of the Checks that read a marked suite's runs carry the same
// note as its failing tests, worded for what they are, and are suspected. They
// are no Gates anyway, and their scoring does not change.

// readableRun is a run of the suite with the events and Findings a real run
// gives, for tests.existing and for the Checks that read the run.
func readableRun(in *Input, events ...string) *Result {
	run := suiteRunOf(in, events...)
	run.Command = []string{"node", "x"}
	run.suite = &suiteRun{Selected: true, Events: parseTestEvents(lines(events...)), Runner: in.runnerName()}
	return run
}

// openSocketRun is a run of the suite that left a socket open.
func openSocketRun(in *Input, events ...string) *Result {
	return readableRun(in, append(events, `{"ev":"end","resources":["TCPSocketWrap"]}`)...)
}

// markedFlakyInput is a package with two tests, whose env file refers to the
// compose Service minio, which the Run does not start, unless static is false.
func markedFlakyInput(t *testing.T, static bool) *Input {
	files := map[string]string{"test/add.test.js": "x", "src/index.js": "x"}
	if static {
		files["test/.test.env"] = "HOST=http://minio:9000/x\n"
	}
	return serviceInput(t, files)
}

func TestFlakyTestsAndNotesOfAStaticallyMarkedSuiteCarryTheNote(t *testing.T) {
	in := markedFlakyInput(t, true)
	threeRuns(t,
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, failedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, passedAdd, endOfSuite) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		what := map[string]string{"flaky-test": "warning", "test-in-some-runs": "note"}[ruleOf(f)]
		wantServiceNote(t, f, "scripts.test", what)
	}
	if n := metricValue(t, res, "flaky_tests"); n != 1 {
		t.Errorf("flaky_tests = %v, want 1: the note changes no count", n)
	}
}

func TestAFlakyTestIsMarkedByALookupErrorItsOwnRepeatRunSaw(t *testing.T) {
	in := markedFlakyInput(t, false)
	threeRuns(t,
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result {
			return readableRun(in, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite)
		},
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	fs := flakyFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantServiceNote(t, fs[0], "scripts.test", "warning")
	wantOwnServiceLimitation(t, res, testsFlakyID)
}

// A Service that the first run marked already has the Limitation of
// tests.existing, so tests.flaky does not add a second one.
func TestAFlakyTestOfASuiteTheFirstRunMarkedAddsNoSecondLimitation(t *testing.T) {
	in := markedFlakyInput(t, true)
	threeRuns(t,
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, failedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) })

	first := testsExisting{}.Run(context.Background(), in)
	res := Implementation(testsFlakyID).Run(context.Background(), in)

	if got := serviceLimitationsOf(first); len(got) != 1 {
		t.Fatalf("tests.existing has %d service_not_started Limitations, want 1: %+v", len(got), got)
	}
	if got := serviceLimitationsOf(res); len(got) != 0 {
		t.Errorf("tests.flaky repeats the Limitation of tests.existing: %+v", got)
	}
}

func TestAFlakyTestOfAnUnmarkedSuiteStaysAsItWas(t *testing.T) {
	in := markedFlakyInput(t, false)
	threeRuns(t,
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, failedAdd, passedSub, endOfSuite) },
		func(in *Input) *Result { return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite) })

	res := Implementation(testsFlakyID).Run(context.Background(), in)

	fs := flakyFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantNoServiceNote(t, fs[0], resultset.ConfidenceConfirmed)
}

// okReadableRun is a first run in which both tests passed.
func okReadableRun(in *Input) *Result {
	return readableRun(in, foundAdd, foundSub, passedAdd, passedSub, endOfSuite)
}

func TestUnhandledRejectionsOfAStaticallyMarkedSuiteCarryTheNote(t *testing.T) {
	in := markedFlakyInput(t, true)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okReadableRun, func(in *Input) *Result {
		return readableRun(in, foundAdd, foundSub, rejectedAdd, passedSub, endOfSuite)
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	fs := rejectionFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantServiceNote(t, fs[0], "scripts.test", "warning")
}

func TestAStrictRunCrashOfAStaticallyMarkedSuiteCarriesTheNote(t *testing.T) {
	in := markedFlakyInput(t, true)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okReadableRun, func(in *Input) *Result { return crashedRun(in, passedAdd) })

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	if len(res.Findings) != 1 || ruleOf(res.Findings[0]) != "unhandled-rejection-crash" {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantServiceNote(t, res.Findings[0], "scripts.test", "warning")
}

func TestAnUnhandledRejectionIsMarkedByALookupErrorTheStrictRunSaw(t *testing.T) {
	in := markedFlakyInput(t, false)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okReadableRun, func(in *Input) *Result {
		return readableRun(in, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite)
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	fs := rejectionFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantServiceNote(t, fs[0], "scripts.test", "warning")
	wantOwnServiceLimitation(t, res, runtimeUnhandledRejectionsID)
}

func TestAnUnhandledRejectionOfAnUnmarkedSuiteStaysAsItWas(t *testing.T) {
	in := markedFlakyInput(t, false)
	in.Selection = selectionWithout(t, testsFlakyID)
	strictRuns(t, okReadableRun, func(in *Input) *Result {
		return readableRun(in, foundAdd, foundSub, rejectedAdd, passedSub, endOfSuite)
	})

	res := Implementation(runtimeUnhandledRejectionsID).Run(context.Background(), in)

	fs := rejectionFindings(res)
	if len(fs) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantNoServiceNote(t, fs[0], resultset.ConfidenceLikely)
}

// wantServiceNote fails unless the Finding carries the note for the suite and
// the Service, worded for a warning, and is suspected.
func wantServiceNote(t *testing.T, f resultset.Finding, suite, what string) {
	t.Helper()
	note := "The suite `" + suite + "` may need the compose Service minio, which the Run did not start, so this " + what + " may come from that and not from the project."
	if !strings.Contains(f.Message, note) {
		t.Errorf("%s lacks the note %q: %q", ruleOf(f), note, f.Message)
	}
	if f.Confidence != resultset.ConfidenceSuspected || len(f.Limitations) != 1 || f.Limitations[0] != serviceNotStarted {
		t.Errorf("%s: confidence = %s, limitations = %v; want suspected and service_not_started", ruleOf(f), f.Confidence, f.Limitations)
	}
	if f.Gate {
		t.Errorf("%s is a Gate", ruleOf(f))
	}
}

func serviceLimitationsOf(res *Result) []resultset.Limitation {
	var out []resultset.Limitation
	for _, l := range res.Limitations {
		if l.ReasonCode == serviceNotStarted {
			out = append(out, l)
		}
	}
	return out
}

// wantOwnServiceLimitation fails unless the Check, whose own run marked the
// suite of scripts.test, reports the Limitation its Findings refer to: the
// first run did not mark the suite, so tests.existing has none.
func wantOwnServiceLimitation(t *testing.T, res *Result, checkID string) {
	t.Helper()
	got := serviceLimitationsOf(res)
	if len(got) != 1 {
		t.Fatalf("%s has %d service_not_started Limitations, want 1: %+v", checkID, len(got), res.Limitations)
	}
	l := got[0]
	if l.CheckID == nil || *l.CheckID != checkID || l.Path == nil {
		t.Errorf("Limitation check = %v, path = %v; want %s and a path", l.CheckID, l.Path, checkID)
	}
	for _, want := range []string{"`scripts.test`", "minio", "EAI_AGAIN"} {
		if !strings.Contains(l.Message, want) {
			t.Errorf("Limitation lacks %q: %s", want, l.Message)
		}
	}
}

func wantNoServiceNote(t *testing.T, f resultset.Finding, confidence resultset.Confidence) {
	t.Helper()
	if strings.Contains(f.Message, "minio") || f.Confidence != confidence || len(f.Limitations) != 0 {
		t.Errorf("%s of an unmarked suite changed: confidence %s, limitations %v, message %q", ruleOf(f), f.Confidence, f.Limitations, f.Message)
	}
}

func TestOpenResourcesOfAStaticallyMarkedSuiteCarryTheNote(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	stubSuite(t, openSocketRun(in, foundAdd, passedAdd))

	testsExisting{}.Run(context.Background(), in)
	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if len(res.Findings) != 1 || ruleOf(res.Findings[0]) != "open-resources" {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantServiceNote(t, res.Findings[0], "scripts.test", "warning")
}

func TestOpenResourcesOfAnUnmarkedSuiteStayAsTheyWere(t *testing.T) {
	in := serviceInput(t, map[string]string{"test/add.test.js": "x"})
	stubSuite(t, openSocketRun(in, foundAdd, passedAdd))

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantNoServiceNote(t, res.Findings[0], resultset.ConfidenceConfirmed)
}

func TestOnlyTheSuiteWithTheRuntimeMarkGetsTheNoteOnItsWarnings(t *testing.T) {
	in := twoSuiteInput(t)
	in.Context.Package.ServiceRefs = nil
	in.Project.Services = []discovery.ComposeService{{Name: "minio", File: "docker-compose.yml", Declared: "quay.io/minio/minio",
		NotStarted: &discovery.Unsupported{Code: "unknown_image", Reason: "the image belongs to no known test Service family"}}}
	stubSuites(t, func(in *Input, ran int) *Result {
		if ran == 0 {
			return openSocketRun(in, foundAdd, foundSub, passedAdd, failedOther)
		}
		return openSocketRun(in, foundAdd, foundSub, passedAdd, failedLookup)
	})

	res := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	wantNoServiceNote(t, res.Findings[0], resultset.ConfidenceConfirmed)
	wantServiceNote(t, res.Findings[1], "test:api", "warning")
}

func TestAMarkedSuiteMakesOnlyTestsExistingPartialNotRuntimeWarnings(t *testing.T) {
	in := serviceInput(t, map[string]string{
		"test/add.test.js": "x",
		"test/.test.env":   "HOST=http://minio:9000/x\n",
	})
	run := suiteRunOf(in, foundAdd, passedAdd, endOfSuite)
	run.Command = []string{"node", "x"}
	run.suite = &suiteRun{Selected: true, Events: parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)), Runner: in.runnerName()}
	stubSuite(t, run)

	tests := testsExisting{}.Run(context.Background(), in)
	warnings := Implementation(runtimeWarningsID).Run(context.Background(), in)

	if tests.Status != resultset.StatusPartial || tests.ReasonCode != "service_not_started" {
		t.Fatalf("tests.existing = %s / %s", tests.Status, tests.ReasonCode)
	}
	if warnings.Status != resultset.StatusCompleted || warnings.ReasonCode != "" || warnings.Reason != "" {
		t.Errorf("runtime.warnings = %s / %s / %q, want completed without a reason", warnings.Status, warnings.ReasonCode, warnings.Reason)
	}
	for _, l := range warnings.Limitations {
		if strings.Contains(l.Message, "Pass rate") {
			t.Errorf("runtime.warnings talks about the Pass rate: %s", l.Message)
		}
	}
}
