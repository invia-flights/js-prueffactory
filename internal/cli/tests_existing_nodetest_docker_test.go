//go:build docker

package cli_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of tests.existing for node:test suites and nested packages,
// with a real Docker daemon and the public npm registry.

func TestANodeTestSuiteShowsOneFailureAndOneTodoWithTheSameDetailAsMocha(t *testing.T) {
	original := copyProject(t, "node-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.Gate != 1 {
		t.Errorf("tests.existing = %+v, want completed, failed, one Gate", e)
	}
	if e.Tool == nil || e.Tool.Name != "node:test" || e.Tool.ExitCode == nil || *e.Tool.ExitCode != 1 {
		t.Errorf("tool = %+v", e.Tool)
	}
	if len(e.Command) < 3 || e.Command[0] != "node" || !slices.Contains(e.Command, "--test") ||
		!slices.Contains(e.Command, "--test-reporter=/jspf/node-test-reporter.js") || !slices.Contains(e.Command, "--test-reporter-destination=stdout") {
		t.Errorf("command = %v", e.Command)
	}

	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want exactly one (the todo test is not a failure)", fs)
	}
	f := fs[0]
	if f.RuleID == nil || *f.RuleID != "test-failed" || !f.Gate || f.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("finding = %+v", f)
	}
	if f.Expected == nil || *f.Expected != "2" || f.Actual == nil || *f.Actual != "8" {
		t.Errorf("expected/actual = %v/%v, want 2/8", f.Expected, f.Actual)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/math.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 13 {
		t.Errorf("locations = %+v, want test/math.test.js:13", f.Locations)
	}
	repro := f.Reproduction.Test
	if repro == nil || repro.Runner != "node:test" || repro.File != "test/math.test.js" || repro.FullTitle != "math subtracts two numbers" {
		t.Fatalf("test repro = %+v", repro)
	}
	if want := []string{"node", "--test", "--test-name-pattern=^math subtracts two numbers$", "test/math.test.js"}; !slices.Equal(repro.NativeCommand, want) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, want)
	}
	var stack string
	for _, ev := range f.Evidence {
		if ev.Kind == "stack_trace" {
			stack = ev.Text
		}
	}
	if !strings.Contains(stack, "test/math.test.js:13") || strings.Contains(stack, "/work/") {
		t.Errorf("stack = %q, want project-relative paths", stack)
	}

	cases := testCasesOf(&r.set, e.ID)
	byTitle := map[string]resultset.TestCase{}
	for _, c := range cases {
		byTitle[c.FullTitle] = c
	}
	if c := byTitle["math subtracts two numbers"]; c.Outcome != resultset.TestFailed || !slices.Equal(c.FindingIDs, []string{f.ID}) ||
		!slices.Equal(c.SuitePath, []string{"math"}) || c.File != "test/math.test.js" {
		t.Errorf("failed case = %+v", c)
	}
	if c := byTitle["math multiplies two numbers"]; c.Outcome != resultset.TestTodo || len(c.FindingIDs) != 0 {
		t.Errorf("todo case = %+v", c)
	}
	if got := passedTitles(t, r, e); !slices.Equal(got, []string{"math adds two numbers"}) {
		t.Errorf("passed = %v", got)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 3, Run: 2, Passed: 1, Failed: 1, Todo: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	overridden := false
	for _, l := range r.set.Limitations {
		overridden = overridden || (l.ReasonCode == "test_command_override" && l.CheckID != nil && *l.CheckID == "tests.existing" && strings.Contains(l.Message, "node --test"))
	}
	if !overridden {
		t.Errorf("limitations = %+v, want the reporter override listed", r.set.Limitations)
	}
	if artifactOf(&r.set, e, "test-output.log") == nil {
		t.Errorf("no test output artifact in %+v", r.set.Artifacts)
	}
	r.assertNothingLeft(t)
}

func TestANestedPackageIsInstalledAndTestedOnItsOwnWithItsOwnContext(t *testing.T) {
	original := copyProject(t, "sub-package")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	suites := executionsOf(&r.set, "tests.existing")
	installs := executionsOf(&r.set, "package.install")
	if len(suites) != 2 || len(installs) != 2 {
		t.Fatalf("suites = %+v, installs = %+v, want two of each", suites, installs)
	}
	paths := map[string]string{} // context ID -> package path
	for _, c := range r.set.Contexts {
		paths[c.ID] = c.Path
	}
	byPath := map[string]resultset.Execution{}
	for _, s := range suites {
		byPath[paths[s.ContextID]] = s
	}
	root, nested := byPath["."], byPath["tools/report"]
	if root.ID == "" || nested.ID == "" || root.ContextID == nested.ContextID {
		t.Fatalf("suites by package path = %+v, want one for . and one for tools/report", byPath)
	}
	for _, s := range suites {
		if s.Status != resultset.StatusCompleted || s.Outcome != resultset.OutcomePassed {
			t.Errorf("suite %+v, want completed and passed", s)
		}
	}
	if root.Tool == nil || root.Tool.Name != "mocha" || nested.Tool == nil || nested.Tool.Name != "node:test" {
		t.Errorf("tools = %+v / %+v, want mocha for the root and node:test for the nested package", root.Tool, nested.Tool)
	}
	// Each suite ran its own tests and only those.
	if got := passedTitles(t, r, root); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("root passed = %v", got)
	}
	if got := passedTitles(t, r, nested); !slices.Equal(got, []string{"label counts several findings", "label names one finding"}) {
		t.Errorf("nested passed = %v", got)
	}
	if got, want := inventoryOf(t, &r.set, nested.ContextID), (resultset.PackageTests{ContextID: nested.ContextID, Found: 2, Run: 2, Passed: 2}); got != want {
		t.Errorf("nested inventory = %+v, want %+v", got, want)
	}
	r.assertNothingLeft(t)
}

func TestNodeTestHooksLoadFailuresAndExitingFilesAreGateFindingsAndNeverRunTests(t *testing.T) {
	original := copyProject(t, "node-test")
	writeFiles(t, original, map[string]string{
		"test/hook.test.js":   "'use strict';\n\nconst { describe, it, before } = require('node:test');\n\ndescribe('guarded', () => {\n  before(() => {\n    throw new Error('the test database is not reachable');\n  });\n  it('needs the database', () => {});\n  it('needs it too', () => {});\n});\n",
		"test/broken.test.js": "'use strict';\n\nconst missing = require('./does-not-exist');\n",
		"test/exits.test.js":  "'use strict';\n\nconst { it } = require('node:test');\n\nit('quits the process', () => {\n  process.exit(3);\n});\nit('would run after', () => {});\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted {
		t.Errorf("tests.existing = %+v, want completed", e)
	}
	rules := map[string]resultset.Finding{} // by rule, and by rule and file for the file failures
	for _, f := range findingsOf(&r.set, "tests.existing") {
		if f.RuleID != nil {
			rules[*f.RuleID] = f
			rules[*f.RuleID+" "+f.Locations[0].Path] = f
		}
	}
	hook := rules["hook-failed"]
	if hook.ID == "" || !hook.Gate || !strings.Contains(hook.Message, "the test database is not reachable") ||
		hook.Locations[0].Path != "test/hook.test.js" || hook.Locations[0].Start == nil || hook.Locations[0].Start.Line != 7 {
		t.Errorf("hook finding = %+v", hook)
	}
	load := rules["test-file-load-failed test/broken.test.js"]
	if load.ID == "" || !load.Gate || load.Locations[0].Path != "test/broken.test.js" || load.Locations[0].Start == nil || load.Locations[0].Start.Line != 3 ||
		len(load.Evidence) == 0 || !strings.Contains(load.Evidence[0].Text, "does-not-exist") || strings.Contains(load.Evidence[0].Text, "/work/") {
		t.Errorf("load finding = %+v", load)
	}
	if rules["test-run-aborted test/exits.test.js"].ID == "" {
		t.Errorf("no finding for the file that quits the process: %v", rules)
	}
	never := 0
	for _, c := range testCasesOf(&r.set, e.ID) {
		if c.Outcome == resultset.TestNeverRun {
			never++
			if c.NeverRunReason == nil || *c.NeverRunReason == "" {
				t.Errorf("%s has no reason", c.FullTitle)
			}
			if strings.HasPrefix(c.FullTitle, "guarded") && (!strings.Contains(*c.NeverRunReason, "before") || !slices.Equal(c.FindingIDs, []string{hook.ID})) {
				t.Errorf("%s = %+v, want never run because of the hook", c.FullTitle, c)
			}
		}
	}
	if never < 2 {
		t.Errorf("never-run cases = %d, want at least the two guarded ones", never)
	}
	counted := false
	for _, l := range r.set.Limitations {
		counted = counted || (l.ReasonCode == "tests_not_counted" && strings.Contains(l.Message, "test/broken.test.js"))
	}
	if !counted {
		t.Errorf("limitations = %+v, want the file that did not load listed", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}
