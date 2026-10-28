package checks

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam B for node:test suites: the event lines of js/node-test-reporter.js go
// in, the same test cases, Findings and counts as for Mocha come out. The
// Docker tests check the lines against a real `node --test`.

// nodeTestInput is a package that runs `node --test`.
func nodeTestInput(t *testing.T, files map[string]string) *Input {
	t.Helper()
	files["package.json"] = `{"scripts":{"test":"node --test"}}`
	return suiteInput(t, files)
}

var nodeNative = []string{"node", "--test"}

func TestAFailedNodeTestIsAGateFindingWithTheNodeTestRerunCommand(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(foundAdd, foundSub, passedAdd, failedSub, endOfSuite))

	r := in.suiteResults(ev, nodeNative)

	f := findingOf(t, r, "test-failed")
	repro := f.Reproduction.Test
	if repro == nil || repro.Runner != "node:test" || repro.File != "test/add.test.js" || repro.FullTitle != "add subtracts" {
		t.Fatalf("test repro = %+v", repro)
	}
	want := []string{"node", "--test", "--test-name-pattern=^add subtracts$", "test/add.test.js"}
	if !slices.Equal(repro.NativeCommand, want) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, want)
	}
	for _, e := range f.Evidence {
		if e.Origin != "node:test" {
			t.Errorf("evidence %q comes from %q, want node:test", e.Kind, e.Origin)
		}
	}
}

func TestTheNameOfANodeTestIsEscapedInItsPatternAndCannotInjectOptions(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"found","file":"/work/-r evil.js","title":"a.b (1+1) [x] {y} $ ^ | \\ *","fullTitle":"--require evil a.b (1+1) [x] {y} $ ^ | \\ *","suitePath":["--require evil"]}`,
		`{"ev":"result","file":"/work/-r evil.js","fullTitle":"--require evil a.b (1+1) [x] {y} $ ^ | \\ *","outcome":"failed","duration":1,"err":{"name":"Error","message":"x"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	cmd := findingOf(t, r, "test-failed").Reproduction.Test.NativeCommand
	want := []string{"node", "--test", `--test-name-pattern=^--require evil a\.b \(1\+1\) \[x\] \{y\} \$ \^ \| \\ \*$`, "./-r evil.js"}
	if !slices.Equal(cmd, want) {
		t.Errorf("native command = %q, want %q", cmd, want)
	}
}

func TestNodeTestTodoAndSkippedTestsAreCountedApartFromPassedOnes(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd, foundSub,
		`{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"later","fullTitle":"add later","suitePath":["add"]}`,
		passedAdd,
		`{"ev":"result","id":2,"outcome":"todo","duration":1,"err":{"name":"Error","message":"not yet"}}`,
		`{"ev":"result","id":3,"outcome":"skipped","duration":0}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	if len(r.Findings) != 0 {
		t.Errorf("a todo test that fails is not a Finding: %+v", r.Findings)
	}
	if c := caseOf(t, r, "add subtracts"); c.Outcome != resultset.TestTodo {
		t.Errorf("todo case = %+v", c)
	}
	if c := caseOf(t, r, "add later"); c.Outcome != resultset.TestSkipped {
		t.Errorf("skipped case = %+v", c)
	}
	want := resultset.PackageTests{ContextID: in.Context.ID, Found: 3, Run: 1, Passed: 1, Skipped: 1, Todo: 1}
	if r.Inventory != want {
		t.Errorf("inventory = %+v, want %+v", r.Inventory, want)
	}
}

func TestAFailedBeforeEachHookOfNodeTestIsOneFindingAndItsTestsNeverRan(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd, foundSub,
		`{"ev":"hook_fail","title":"\"beforeEach\" hook","hookType":"beforeEach","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"beforeEach broke","stack":"Error: beforeEach broke\n    at TestContext.<anonymous> (/work/test/add.test.js:4:9)"}}`,
		`{"ev":"hook_fail","title":"\"beforeEach\" hook","hookType":"beforeEach","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"beforeEach broke","stack":"Error: beforeEach broke\n    at TestContext.<anonymous> (/work/test/add.test.js:4:9)"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	if len(r.Findings) != 1 {
		t.Fatalf("findings = %+v, want one for the hook", r.Findings)
	}
	f := findingOf(t, r, "hook-failed")
	if f.Reproduction.Test == nil || f.Reproduction.Test.Runner != "node:test" ||
		!slices.Equal(f.Reproduction.Test.NativeCommand, []string{"node", "--test", "test/add.test.js"}) {
		t.Errorf("test repro = %+v", f.Reproduction.Test)
	}
	c := caseOf(t, r, "add adds")
	if c.Outcome != resultset.TestNeverRun || c.NeverRunReason == nil || !strings.Contains(*c.NeverRunReason, "beforeEach") ||
		!slices.Equal(c.Findings, []int{0}) {
		t.Errorf("guarded case = %+v", c)
	}
}

func TestANodeTestFileThatFailsToLoadIsAGateFindingWithItsError(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x", "test/broken.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd, passedAdd,
		`{"ev":"file_fail","file":"/work/test/broken.test.js","err":{"name":"Error","message":"test failed"},"text":"Error: Cannot find module './missing'\nRequire stack:\n- /work/test/broken.test.js\n    at Object.<anonymous> (/work/test/broken.test.js:1:11)"}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	f := findingOf(t, r, "test-file-load-failed")
	if !f.Gate || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("finding = %+v", f)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/broken.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 1 {
		t.Errorf("locations = %+v", f.Locations)
	}
	if !strings.Contains(f.Message, "Cannot find module './missing'") || !strings.Contains(f.Message, "test/broken.test.js") {
		t.Errorf("message = %q", f.Message)
	}
	var text string
	for _, e := range f.Evidence {
		if e.Kind == "tool_output" {
			text = e.Text
		}
	}
	if !strings.Contains(text, "Require stack") || strings.Contains(text, "/work/") {
		t.Errorf("evidence = %q, want the output with project-relative paths", text)
	}
	if got := caseOf(t, r, "add adds"); got.Outcome != resultset.TestPassed {
		t.Errorf("the other file's test = %+v", got)
	}
}

func TestANodeTestFileThatReportsNothingAndPrintsNoErrorIsAnAbortedProcessNotALoadFailure(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/exits.test.js": "x"})
	ev := parseTestEvents(lines(
		`{"ev":"file_fail","file":"/work/test/exits.test.js","err":{"name":"Error","message":"test failed"},"text":""}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	f := findingOf(t, r, "test-run-aborted")
	if !f.Gate || !strings.Contains(f.Message, "process.exit()") || f.Locations[0].Path != "test/exits.test.js" {
		t.Errorf("finding = %+v", f)
	}
}

func TestANodeTestFileWhoseProcessStopsMidwayLeavesItsUnfinishedTestsNeverRun(t *testing.T) {
	in := nodeTestInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd, foundSub, passedAdd,
		`{"ev":"file_fail","file":"/work/test/add.test.js","err":{"name":"Error","message":"test failed"},"text":""}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, nodeNative)

	f := findingOf(t, r, "test-run-aborted")
	if !f.Gate || !strings.Contains(f.Message, "test/add.test.js") {
		t.Errorf("finding = %+v", f)
	}
	c := caseOf(t, r, "add subtracts")
	if c.Outcome != resultset.TestNeverRun || c.NeverRunReason == nil || !strings.Contains(*c.NeverRunReason, "test/add.test.js") {
		t.Errorf("unfinished case = %+v", c)
	}
}
