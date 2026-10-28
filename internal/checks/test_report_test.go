package checks

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests are seam B for the test runner step: the event lines our
// embedded reporter writes go in, test cases, Findings and Inventory counts
// come out. The event lines follow the reporter's format (js/mocha-reporter.js),
// which the Docker tests then check against a real Mocha.

// suiteInput is an Input for a package at the project root, with the given
// project files in its Snapshot copy.
func suiteInput(t *testing.T, files map[string]string) *Input {
	t.Helper()
	root := t.TempDir()
	if _, ok := files["package.json"]; !ok {
		files["package.json"] = `{"scripts":{"test":"mocha"}}`
	}
	for rel, content := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	return &Input{Project: proj, Context: &proj.Contexts[1], OriginalPath: "/orig", SnapshotDir: root}
}

func lines(l ...string) []byte { return []byte(strings.Join(l, "\n") + "\n") }

const (
	foundAdd   = `{"ev":"found","id":1,"file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"]}`
	foundSub   = `{"ev":"found","id":2,"file":"/work/test/add.test.js","title":"subtracts","fullTitle":"add subtracts","suitePath":["add"]}`
	passedAdd  = `{"ev":"result","id":1,"outcome":"passed","duration":3}`
	failedSub  = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"AssertionError","message":"Expected values to be strictly equal:\n\n5 !== 6\n","expected":"6","actual":"5","stack":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n5 !== 6\n\n    at Context.<anonymous> (/work/test/add.test.js:9:12)\n    at process.processImmediate (node:internal/timers:485:21)"}}`
	endOfSuite = `{"ev":"end"}`
)

var mochaNative = []string{"npx", "mocha"}

func findingOf(t *testing.T, r *suiteResults, rule string) resultset.Finding {
	t.Helper()
	for _, f := range r.Findings {
		if f.RuleID != nil && *f.RuleID == rule {
			return f
		}
	}
	t.Fatalf("no %s Finding in %+v", rule, r.Findings)
	return resultset.Finding{}
}

func caseOf(t *testing.T, r *suiteResults, title string) SuiteTestCase {
	t.Helper()
	for _, c := range r.TestCases {
		if c.FullTitle == title {
			return c
		}
	}
	t.Fatalf("no test case %q in %+v", title, r.TestCases)
	return SuiteTestCase{}
}

func TestAFailedTestIsAGateFindingWithEverythingAnAgentNeedsToFixIt(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(foundAdd, foundSub, passedAdd, failedSub, endOfSuite))

	r := in.suiteResults(ev, mochaNative)

	if len(r.Findings) != 1 {
		t.Fatalf("findings = %+v", r.Findings)
	}
	f := findingOf(t, r, "test-failed")
	if !f.Gate || f.Confidence != resultset.ConfidenceConfirmed || f.Severity != resultset.SeverityError || f.Kind != resultset.KindDefect {
		t.Errorf("finding = %+v", f)
	}
	if f.CheckID != "tests.existing" || f.ContextID != in.Context.ID {
		t.Errorf("check/context = %s %s", f.CheckID, f.ContextID)
	}
	if f.Expected == nil || *f.Expected != "6" || f.Actual == nil || *f.Actual != "5" {
		t.Errorf("expected/actual = %v/%v", f.Expected, f.Actual)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/add.test.js" || f.Locations[0].Start == nil ||
		f.Locations[0].Start.Line != 9 || f.Locations[0].Start.Column == nil || *f.Locations[0].Start.Column != 12 {
		t.Errorf("locations = %+v", f.Locations)
	}
	if !strings.Contains(f.Title, "add subtracts") || !strings.Contains(f.Message, "5 !== 6") {
		t.Errorf("title/message = %q / %q", f.Title, f.Message)
	}
	// The stack is Evidence, with container paths shown relative to the package.
	var stack string
	for _, e := range f.Evidence {
		if e.Kind == "stack_trace" {
			stack = e.Text
		}
		if e.Trust != resultset.TrustUntrusted {
			t.Errorf("evidence %q is not marked untrusted", e.Kind)
		}
	}
	if !strings.Contains(stack, "(test/add.test.js:9:12)") || strings.Contains(stack, "/work/") {
		t.Errorf("stack = %q", stack)
	}
	// Re-running: our own command, and the project's native one as argument arrays.
	if got := f.Reproduction.Rerun; !slices.Equal(got, []string{"js-prueffactory", "test", "/orig", "--only", "tests.existing"}) {
		t.Errorf("rerun = %v", got)
	}
	repro := f.Reproduction.Test
	if repro == nil || repro.Runner != "mocha" || repro.File != "test/add.test.js" || repro.FullTitle != "add subtracts" {
		t.Fatalf("test repro = %+v", repro)
	}
	if want := []string{"npx", "mocha", "--fgrep", "add subtracts", "test/add.test.js"}; !slices.Equal(repro.NativeCommand, want) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, want)
	}

	// Test cases: the passed one and the failed one, linked to the Finding.
	failed := caseOf(t, r, "add subtracts")
	if failed.Outcome != resultset.TestFailed || !slices.Equal(failed.Findings, []int{0}) ||
		failed.File != "test/add.test.js" || !slices.Equal(failed.SuitePath, []string{"add"}) {
		t.Errorf("failed case = %+v", failed)
	}
	if len(failed.Attempts) != 1 || failed.Attempts[0].Outcome != resultset.TestFailed || failed.Attempts[0].DurationMS != 5 ||
		failed.Attempts[0].Error == nil || !strings.Contains(*failed.Attempts[0].Error, "5 !== 6") {
		t.Errorf("attempts = %+v", failed.Attempts)
	}
	passed := caseOf(t, r, "add adds")
	if passed.Outcome != resultset.TestPassed || len(passed.Findings) != 0 || passed.Flaky {
		t.Errorf("passed case = %+v", passed)
	}
	want := resultset.PackageTests{ContextID: in.Context.ID, Found: 2, Run: 2, Passed: 1, Failed: 1}
	if r.Inventory != want {
		t.Errorf("inventory = %+v, want %+v", r.Inventory, want)
	}
}

// Mocha shortens the paths in a stack to the folder it runs in, so a frame is
// relative to the package, not an absolute path in the container.
func TestStackFramesThatMochaShortenedToThePackageFolderAreFound(t *testing.T) {
	root := t.TempDir()
	for rel, content := range map[string]string{
		"package.json": `{}`, "sub/package.json": `{"scripts":{"test":"mocha"}}`, "sub/test/a.test.js": "x",
	} {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	in := &Input{Project: proj, Context: &proj.Contexts[2], OriginalPath: "/orig", SnapshotDir: root}
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/sub/test/a.test.js","title":"t","fullTitle":"s t","suitePath":["s"]}`,
		`{"ev":"result","id":1,"outcome":"failed","duration":1,"err":{"name":"Error","message":"boom","stack":"Error: boom\n    at Context.<anonymous> (test/a.test.js:7:11)\n    at process.processImmediate (node:internal/timers:574:21)"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	f := findingOf(t, r, "test-failed")
	if loc := f.Locations[0]; loc.Path != "sub/test/a.test.js" || loc.Start == nil || loc.Start.Line != 7 || *loc.Start.Column != 11 {
		t.Errorf("location = %+v, want sub/test/a.test.js:7:11", loc)
	}
	// The re-run command runs in the package folder, so its file is relative to it.
	if got := f.Reproduction.Test.NativeCommand; got[len(got)-1] != "test/a.test.js" {
		t.Errorf("native command = %q", got)
	}
}

func TestSkippedAndNeverRunTestsAreCountedApartFromRunOnes(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd, foundSub,
		`{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"later","fullTitle":"add later","suitePath":["add"]}`,
		passedAdd,
		`{"ev":"result","id":2,"outcome":"skipped","duration":0}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	if skipped := caseOf(t, r, "add subtracts"); skipped.Outcome != resultset.TestSkipped || skipped.NeverRunReason != nil {
		t.Errorf("skipped = %+v", skipped)
	}
	never := caseOf(t, r, "add later")
	if never.Outcome != resultset.TestNeverRun || never.NeverRunReason == nil || *never.NeverRunReason == "" {
		t.Errorf("never run = %+v", never)
	}
	want := resultset.PackageTests{ContextID: in.Context.ID, Found: 3, Run: 1, Passed: 1, Skipped: 1, NeverRun: 1}
	if r.Inventory != want {
		t.Errorf("inventory = %+v, want %+v", r.Inventory, want)
	}
}

func TestAFailedHookIsOneFindingAndTheTestsItPreventedNeverRan(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/setup.js": "x", "test/a.test.js": "x", "test/b.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"]}`,
		`{"ev":"found","id":2,"file":"/work/test/a.test.js","title":"two","fullTitle":"a two","suitePath":["a"]}`,
		`{"ev":"found","id":3,"file":"/work/test/b.test.js","title":"three","fullTitle":"b three","suitePath":["b"]}`,
		`{"ev":"hook_fail","title":"\"before all\" hook in \"{root}\"","hookType":"before all","scope":"{root}","scopePath":[],"file":"/work/test/setup.js","err":{"name":"Error","message":"database is down","stack":"Error: database is down\n    at Context.<anonymous> (/work/test/setup.js:4:11)"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	if len(r.Findings) != 1 {
		t.Fatalf("a failed hook is one Finding, got %+v", r.Findings)
	}
	f := findingOf(t, r, "hook-failed")
	if !f.Gate || f.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("hook finding = %+v", f)
	}
	for _, want := range []string{"before all", "{root}", "database is down"} {
		if !strings.Contains(f.Title+" "+f.Message, want) {
			t.Errorf("title and message %q %q lack %q", f.Title, f.Message, want)
		}
	}
	if f.Locations[0].Path != "test/setup.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 4 {
		t.Errorf("location = %+v", f.Locations[0])
	}
	if f.Reproduction.Test == nil || f.Reproduction.Test.File != "test/setup.js" {
		t.Errorf("repro = %+v", f.Reproduction.Test)
	}
	for _, title := range []string{"a one", "a two", "b three"} {
		c := caseOf(t, r, title)
		if c.Outcome != resultset.TestNeverRun || c.NeverRunReason == nil ||
			!strings.Contains(*c.NeverRunReason, "before all") || !strings.Contains(*c.NeverRunReason, "database is down") ||
			!slices.Equal(c.Findings, []int{0}) {
			t.Errorf("%s = %+v, want never_run with the hook as reason and Finding", title, c)
		}
	}
	if r.Inventory.NeverRun != 3 || r.Inventory.Failed != 0 {
		t.Errorf("inventory = %+v", r.Inventory)
	}
}

func TestAHookOnlyPreventsTheTestsInsideItsSuite(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "test/b.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"]}`,
		`{"ev":"found","id":2,"file":"/work/test/b.test.js","title":"two","fullTitle":"b two","suitePath":["b"]}`,
		`{"ev":"hook_fail","title":"\"before each\" hook for \"one\"","hookType":"before each","scope":"a","scopePath":["a"],"file":"/work/test/a.test.js","err":{"name":"Error","message":"boom"}}`,
		`{"ev":"result","id":2,"outcome":"passed","duration":1}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	if c := caseOf(t, r, "a one"); c.Outcome != resultset.TestNeverRun || !strings.Contains(*c.NeverRunReason, `"a"`) {
		t.Errorf("a one = %+v", c)
	}
	if c := caseOf(t, r, "b two"); c.Outcome != resultset.TestPassed {
		t.Errorf("b two = %+v", c)
	}
}

func TestTheSameHookFailingForSeveralTestsIsOneFinding(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x"})
	hook := func(test string) string {
		return `{"ev":"hook_fail","title":"\"after each\" hook for \"` + test + `\"","hookType":"after each","scope":"a","scopePath":["a"],"file":"/work/test/a.test.js","err":{"name":"Error","message":"cleanup failed"}}`
	}
	ev := parseTestEvents(lines(hook("one"), hook("two"), endOfSuite))

	if r := in.suiteResults(ev, mochaNative); len(r.Findings) != 1 {
		t.Errorf("findings = %+v", r.Findings)
	}
}

func TestATestThatPassedOnlyOnRetryIsFlaky(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd,
		`{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"first attempt failed"}}`,
		`{"ev":"result","id":1,"outcome":"passed","duration":6}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	c := caseOf(t, r, "add adds")
	if c.Outcome != resultset.TestPassed || !c.Flaky || len(c.Attempts) != 2 ||
		c.Attempts[0].Outcome != resultset.TestFailed || c.Attempts[0].Error == nil || *c.Attempts[0].Error != "first attempt failed" ||
		c.Attempts[1].Outcome != resultset.TestPassed {
		t.Errorf("case = %+v", c)
	}
	if len(r.Findings) != 0 {
		t.Errorf("a test that passed is no Finding: %+v", r.Findings)
	}
}

func TestResultsSurviveACrashAndTestsNotYetRunAreNeverRun(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	// No end event, and the last line was cut when the process died.
	data := append(lines(foundAdd, foundSub, passedAdd), []byte(`{"ev":"result","id":2,"outc`)...)

	ev := parseTestEvents(data)
	r := in.suiteResults(ev, mochaNative)

	if c := caseOf(t, r, "add adds"); c.Outcome != resultset.TestPassed {
		t.Errorf("the result recorded before the crash is kept: %+v", c)
	}
	c := caseOf(t, r, "add subtracts")
	if c.Outcome != resultset.TestNeverRun || c.NeverRunReason == nil || !strings.Contains(*c.NeverRunReason, "stopped") {
		t.Errorf("subtracts = %+v", c)
	}
	if ev.Ended {
		t.Error("no end event was written")
	}
}

func TestFocusedTestsExcludeTheOthersAndAreCounted(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"],"focused":true}`,
		foundSub,
		`{"ev":"result","id":1,"outcome":"passed","duration":1}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	c := caseOf(t, r, "add subtracts")
	if c.Outcome != resultset.TestNeverRun || c.NeverRunReason == nil || !strings.Contains(*c.NeverRunReason, ".only") {
		t.Errorf("subtracts = %+v", c)
	}
	if r.Inventory.Focused != 1 || r.Inventory.NeverRun != 1 || r.Inventory.Found != 2 {
		t.Errorf("inventory = %+v", r.Inventory)
	}
}

// The Benchmark's pass rate is the mean over test files, so the Inventory
// counts the tests of each file: every kind of test found, and the passed
// ones, among them the focused ones that passed.
func TestTheInventoryCountsTheTestsOfEachFileForThePassRate(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/a.test.js": "x", "test/b.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"],"focused":true}`,
		`{"ev":"found","id":2,"file":"/work/test/a.test.js","title":"two","fullTitle":"a two","suitePath":["a"]}`,
		`{"ev":"found","id":3,"file":"/work/test/b.test.js","title":"three","fullTitle":"b three","suitePath":["b"]}`,
		`{"ev":"found","id":4,"file":"/work/test/b.test.js","title":"four","fullTitle":"b four","suitePath":["b"]}`,
		`{"ev":"result","id":1,"outcome":"passed","duration":1}`,
		`{"ev":"result","id":3,"outcome":"passed","duration":1}`,
		`{"ev":"result","id":4,"outcome":"failed","duration":1,"err":{"name":"Error","message":"x","stack":"Error: x"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	want := []resultset.TestFileCount{
		{ContextID: in.Context.ID, File: "test/a.test.js", Found: 2, Passed: 1, PassedFocused: 1},
		{ContextID: in.Context.ID, File: "test/b.test.js", Found: 2, Passed: 1},
	}
	if got := r.Files; !slices.Equal(got, want) {
		t.Errorf("files = %+v, want %+v", got, want)
	}
}

func TestResultsWithoutAnAnnouncementAreStillRecorded(t *testing.T) {
	// A parallel Mocha run does not announce its tests up front.
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"result","file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"],"outcome":"passed","duration":2}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	if c := caseOf(t, r, "add adds"); c.Outcome != resultset.TestPassed || c.File != "test/add.test.js" {
		t.Errorf("case = %+v", c)
	}
	if r.Inventory.Found != 1 || r.Inventory.Passed != 1 {
		t.Errorf("inventory = %+v", r.Inventory)
	}
}

func TestTitlesAndFilesThatLookLikeOptionsCannotInjectOptions(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","id":1,"file":"/work/-r evil.js","title":"--require evil","fullTitle":"--require evil","suitePath":[]}`,
		`{"ev":"result","id":1,"outcome":"failed","duration":1,"err":{"name":"Error","message":"x"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	cmd := findingOf(t, r, "test-failed").Reproduction.Test.NativeCommand
	if want := []string{"npx", "mocha", "--fgrep=--require evil", "./-r evil.js"}; !slices.Equal(cmd, want) {
		t.Errorf("native command = %q, want %q", cmd, want)
	}
}

func TestNoEventsAtAllMeansMochaNeverGotToRunAnyTest(t *testing.T) {
	ev := parseTestEvents(nil)
	if ev.Ended || len(ev.Tests) != 0 || ev.Started {
		t.Errorf("events = %+v", ev)
	}
}
