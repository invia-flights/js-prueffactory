//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of tests.existing with a real Docker daemon and the public npm
// registry: the project's own Mocha suite runs in its package container, and
// every result lands in the Report.

func testCasesOf(s *resultset.Set, execution string) []resultset.TestCase {
	var out []resultset.TestCase
	for _, tc := range s.TestCases {
		if tc.ExecutionID == execution {
			out = append(out, tc)
		}
	}
	return out
}

// passedTitles reads the artifact that lists the passed test cases of an
// execution and returns their full titles.
func passedTitles(t *testing.T, r *dockerRun, e resultset.Execution) []string {
	t.Helper()
	a := artifactOf(&r.set, e, "tests.existing-"+e.ContextID+"-passed.json")
	if a == nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(a.Path)))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Passed []struct {
			FullTitle string `json:"full_title"`
		} `json:"passed"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, p := range doc.Passed {
		titles = append(titles, p.FullTitle)
	}
	return titles
}

func inventoryOf(t *testing.T, s *resultset.Set, contextID string) resultset.PackageTests {
	t.Helper()
	for _, p := range s.Inventory.Tests {
		if p.ContextID == contextID {
			return p
		}
	}
	t.Fatalf("no test inventory for %s in %+v", contextID, s.Inventory.Tests)
	return resultset.PackageTests{}
}

func TestACleanMochaSuitePassesAndOnlyTestsExistingRunsTheInstallAsAPrerequisite(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if !e.Selected || e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomePassed {
		t.Errorf("tests.existing = %+v", e)
	}
	if e.Tool == nil || e.Tool.Name != "mocha" || e.Tool.Version == nil || !strings.HasPrefix(*e.Tool.Version, "10.") || e.Tool.ExitCode == nil || *e.Tool.ExitCode != 0 {
		t.Errorf("tool = %+v, want the project's own Mocha 10", e.Tool)
	}
	// The install ran as a prerequisite and the Report says so.
	install := oneExecution(t, &r.set, "package.install")
	if install.Selected || install.Status != resultset.StatusCompleted {
		t.Errorf("package.install = %+v, want an unselected prerequisite that completed", install)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); !slices.Equal(got, []string{"package.install"}) {
		t.Errorf("prerequisites_run = %v", got)
	}
	if got := r.set.Selection.EffectiveChecks; !slices.Equal(got, []string{"tests.existing"}) {
		t.Errorf("effective checks = %v, want only tests.existing", got)
	}
	// One test, passed: it is counted and listed in the artifact, not in test_cases.
	if len(r.set.TestCases) != 0 || r.set.Summary.TestCases.Passed != 1 {
		t.Errorf("test_cases = %+v, summary = %+v", r.set.TestCases, r.set.Summary.TestCases)
	}
	if got := passedTitles(t, r, e); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("passed artifact = %v", got)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 1, Run: 1, Passed: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	// The Report lists the override of the project's command, and the suite's
	// output is saved.
	found := false
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "test_command_override" && l.CheckID != nil && *l.CheckID == "tests.existing" {
			found = true
		}
	}
	if !found {
		t.Errorf("limitations = %+v, want the reporter override listed", r.set.Limitations)
	}
	if artifactOf(&r.set, e, "test-output.log") == nil {
		t.Errorf("no test output artifact in %+v", r.set.Artifacts)
	}
	if len(e.Command) < 3 || e.Command[0] != "node" || !strings.HasSuffix(e.Command[1], "/node_modules/mocha/bin/mocha.js") {
		t.Errorf("command = %v", e.Command)
	}
	r.assertNothingLeft(t)
}

func TestAFailingTestIsOneGateFindingWithFileTitleExpectedActualAndRerunCommands(t *testing.T) {
	original := copyProject(t, "failing-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.Gate != 1 {
		t.Errorf("tests.existing = %+v, want completed, failed, one Gate", e)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want exactly one", fs)
	}
	f := fs[0]
	if !f.Gate || f.Confidence != resultset.ConfidenceConfirmed || f.Severity != resultset.SeverityError {
		t.Errorf("finding = %+v", f)
	}
	if f.Expected == nil || *f.Expected != "2" || f.Actual == nil || *f.Actual != "-2" {
		t.Errorf("expected/actual = %v/%v, want 2/-2", f.Expected, f.Actual)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "test/add.test.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 13 ||
		len(f.Locations[0].FileSHA256) != 64 {
		t.Errorf("locations = %+v, want test/add.test.js:13 with the file's hash", f.Locations)
	}
	repro := f.Reproduction.Test
	if repro == nil || repro.Runner != "mocha" || repro.File != "test/add.test.js" || repro.FullTitle != "add adds negative numbers" {
		t.Fatalf("test repro = %+v", repro)
	}
	if want := []string{"npx", "mocha", "--fgrep", "add adds negative numbers", "test/add.test.js"}; !slices.Equal(repro.NativeCommand, want) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, want)
	}
	if want := []string{"js-prueffactory", "test", r.set.Source.OriginalPath, "--only", "tests.existing"}; !slices.Equal(f.Reproduction.Rerun, want) {
		t.Errorf("rerun = %q", f.Reproduction.Rerun)
	}
	var stack string
	for _, ev := range f.Evidence {
		if ev.Kind == "stack_trace" {
			stack = ev.Text
		}
	}
	if !strings.Contains(stack, "test/add.test.js:13") || strings.Contains(stack, "/work/") {
		t.Errorf("stack = %q, want project-relative paths", stack)
	}

	// The failed test is a test case linked to the Finding; the passed one is
	// only in the artifact.
	cases := testCasesOf(&r.set, e.ID)
	if len(cases) != 1 || cases[0].Outcome != resultset.TestFailed || cases[0].FullTitle != "add adds negative numbers" ||
		!slices.Equal(cases[0].FindingIDs, []string{f.ID}) || !slices.Equal(cases[0].SuitePath, []string{"add"}) || cases[0].File != "test/add.test.js" {
		t.Errorf("test cases = %+v", cases)
	}
	if got := passedTitles(t, r, e); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("passed = %v", got)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 2, Run: 2, Passed: 1, Failed: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	if r.set.Summary.TestCases.Failed != 1 || r.set.Summary.TestCases.Passed != 1 {
		t.Errorf("summary = %+v", r.set.Summary.TestCases)
	}
	r.assertNothingLeft(t)
}

func TestAFailingRootHookIsOneFindingAndTheTestsItPreventedAreNeverRun(t *testing.T) {
	original := copyProject(t, "failing-root-hook")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 || fs[0].RuleID == nil || *fs[0].RuleID != "hook-failed" || !fs[0].Gate {
		t.Fatalf("findings = %+v, want one hook Finding", fs)
	}
	for _, want := range []string{"before all", "the test database is not reachable"} {
		if !strings.Contains(fs[0].Title+" "+fs[0].Message, want) {
			t.Errorf("hook finding %q %q lacks %q", fs[0].Title, fs[0].Message, want)
		}
	}
	if fs[0].Locations[0].Path != "test/setup.js" || fs[0].Locations[0].Start == nil || fs[0].Locations[0].Start.Line != 5 {
		t.Errorf("hook location = %+v, want test/setup.js:5", fs[0].Locations[0])
	}
	e := oneExecution(t, &r.set, "tests.existing")
	cases := testCasesOf(&r.set, e.ID)
	if len(cases) != 3 {
		t.Fatalf("test cases = %+v, want the three tests that never ran", cases)
	}
	for _, tc := range cases {
		if tc.Outcome != resultset.TestNeverRun || tc.NeverRunReason == nil || !strings.Contains(*tc.NeverRunReason, "before all") ||
			!slices.Equal(tc.FindingIDs, []string{fs[0].ID}) {
			t.Errorf("%s = %+v", tc.FullTitle, tc)
		}
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 3, NeverRun: 3}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	if r.set.Summary.TestCases.Failed != 0 || r.set.Summary.TestCases.NeverRun != 3 {
		t.Errorf("summary = %+v", r.set.Summary.TestCases)
	}
	r.assertNothingLeft(t)
}

func TestAJestProjectIsUnsupportedAndNoInstallRunsForIt(t *testing.T) {
	original := copyProject(t, "jest-unsupported")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "test_runner_unsupported" ||
		e.Reason == nil || !strings.Contains(*e.Reason, "Jest") || !strings.Contains(*e.Reason, "jest --ci") ||
		!strings.Contains(*e.Reason, "js-prueffactory runs only `mocha …` and `node … --test …`") {
		t.Errorf("tests.existing = %+v, want unsupported naming Jest, the script and the runners the tool runs", e)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 0 {
		t.Errorf("there is nothing to install for: prerequisites_run = %v", got)
	}
	if len(r.set.Findings) != 0 {
		t.Errorf("findings = %+v", r.set.Findings)
	}
	r.assertNothingLeft(t)
}

func TestAFailedInstallBlocksTheSuiteAsTheProjectsFault(t *testing.T) {
	original := copyProject(t, "lockfile-mismatch")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,tests.existing")

	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusBlocked || e.ReasonCode == nil || *e.ReasonCode != "prerequisite_failed_project" {
		t.Errorf("tests.existing = %+v, want blocked as the project's fault", e)
	}
	r.assertNothingLeft(t)
}
