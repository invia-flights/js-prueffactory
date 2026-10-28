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

// Seam A tests of tests.coverage with a real Docker daemon and the public npm
// registry: c8 from the toolset wraps the project's own runner, so the one
// test run per suite also measures coverage.

func coverageMetrics(s *resultset.Set) map[string]resultset.Metric {
	out := map[string]resultset.Metric{}
	for _, m := range s.Metrics {
		if m.CheckID == "tests.coverage" {
			out[m.Name] = m
		}
	}
	return out
}

type coverageFiles struct {
	Package string `json:"package"`
	Files   []struct {
		Path      string `json:"path"`
		Functions struct {
			Total   int      `json:"total"`
			Covered int      `json:"covered"`
			Percent *float64 `json:"percent"`
		} `json:"functions"`
		Untested []struct {
			Name string `json:"name"`
			Line int    `json:"line"`
		} `json:"untested_functions"`
	} `json:"files"`
}

func coverageFilesOf(t *testing.T, r *dockerRun, e resultset.Execution) coverageFiles {
	t.Helper()
	a := artifactOf(&r.set, e, e.ContextID+"-files.json")
	if a == nil {
		t.Fatalf("no per-file coverage artifact in %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(a.Path)))
	if err != nil {
		t.Fatal(err)
	}
	var doc coverageFiles
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestAMochaSuiteHasLineBranchAndFunctionCoverageAndTheUntestedFunctionIsInTheArtifact(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.coverage")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.coverage")
	if !e.Selected || e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeObservationsOnly || e.Gate != 0 {
		t.Errorf("tests.coverage = %+v", e)
	}
	// tests.existing was not asked for: it reports nothing, and the suite ran
	// for the coverage.
	if got := r.set.Selection.EffectiveChecks; !slices.Equal(got, []string{"tests.coverage"}) {
		t.Errorf("effective checks = %v", got)
	}
	if len(r.set.Inventory.Tests) != 0 && inventoryOf(t, &r.set, e.ContextID).Found != 0 {
		t.Errorf("tests.existing is not selected, but the Report counts its tests: %+v", r.set.Inventory.Tests)
	}

	ms := coverageMetrics(&r.set)
	if len(ms) != 3 {
		t.Fatalf("metrics = %+v, want lines, branches and functions", ms)
	}
	for _, name := range []string{"lines", "branches", "functions"} {
		m := ms[name]
		if m.Value == nil || m.Unit != "percent" || m.ContextID != e.ContextID || m.Reason != nil {
			t.Errorf("%s = %+v", name, m)
		}
	}
	// add() is called, subtract() is not.
	if f := ms["functions"]; f.Value == nil || *f.Value != 50 {
		t.Errorf("function coverage = %+v, want 50: one of two functions is tested", f)
	}
	if l := ms["lines"]; l.Value == nil || *l.Value <= 0 || *l.Value >= 100 {
		t.Errorf("line coverage = %+v, want between 0 and 100", l)
	}

	doc := coverageFilesOf(t, r, e)
	if doc.Package != "." || len(doc.Files) != 1 || doc.Files[0].Path != "src/index.js" {
		t.Fatalf("files = %+v, want only src/index.js: Test code and node_modules are excluded", doc)
	}
	if u := doc.Files[0].Untested; len(u) != 1 || u[0].Name != "subtract" || u[0].Line != 9 {
		t.Errorf("untested functions = %+v, want subtract on line 9", u)
	}

	var tools []string
	for _, c := range r.set.Contexts {
		if c.ID == e.ContextID {
			for _, tool := range c.Tools {
				tools = append(tools, tool.Name+"@"+tool.Version)
			}
		}
	}
	if !slices.Contains(tools, "c8@12.0.0") {
		t.Errorf("context tools = %v, want c8@12.0.0", tools)
	}
	if e.Tool == nil || e.Tool.Name != "c8" || e.Tool.ExitCode == nil || *e.Tool.ExitCode != 0 {
		t.Errorf("tool = %+v", e.Tool)
	}
	r.assertNothingLeft(t)
}

func TestTheSuiteRunsOnceForTestsExistingAndTestsCoverageAndBothReadThatRun(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	suite := oneExecution(t, &r.set, "tests.existing")
	cov := oneExecution(t, &r.set, "tests.coverage")
	if suite.Status != resultset.StatusCompleted || cov.Status != resultset.StatusCompleted {
		t.Fatalf("suite = %+v, coverage = %+v", suite, cov)
	}
	// One run: the command is c8's with Mocha inside, for both.
	if len(suite.Command) < 6 || suite.Command[0] != "node" || !strings.HasSuffix(suite.Command[1], "/c8/bin/c8.js") ||
		!slices.Contains(suite.Command, "--") || !slices.Contains(suite.Command, "--no-bail") {
		t.Errorf("tests.existing command = %v, want Mocha wrapped by c8", suite.Command)
	}
	if !slices.Equal(suite.Command, cov.Command) {
		t.Errorf("commands differ, so the suite ran twice: %v and %v", suite.Command, cov.Command)
	}
	want := resultset.PackageTests{ContextID: suite.ContextID, Found: 1, Run: 1, Passed: 1}
	if got := inventoryOf(t, &r.set, suite.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	if got := passedTitles(t, r, suite); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("passed = %v", got)
	}
	if m := coverageMetrics(&r.set)["functions"]; m.Value == nil || *m.Value != 50 {
		t.Errorf("function coverage = %+v", m)
	}
	if artifactOf(&r.set, suite, "test-output.log") == nil {
		t.Errorf("no test output artifact in %+v", r.set.Artifacts)
	}
	r.assertNothingLeft(t)
}

func TestWhenTestsFailTheCoverageIsStillMeasuredAndEveryMetricCarriesANote(t *testing.T) {
	original := copyProject(t, "failing-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (the failing test is a Gate)\nstderr:\n%s", r.code, r.stderr)
	}
	cov := oneExecution(t, &r.set, "tests.coverage")
	if cov.Status != resultset.StatusCompleted || cov.Gate != 0 || len(cov.FindingIDs) != 0 {
		t.Errorf("tests.coverage = %+v, want completed, and measurement only", cov)
	}
	ms := coverageMetrics(&r.set)
	if len(ms) != 3 {
		t.Fatalf("metrics = %+v", ms)
	}
	for name, m := range ms {
		if m.Value == nil {
			t.Errorf("%s has no value: %+v", name, m)
		}
		if m.Reason == nil || !strings.Contains(*m.Reason, "1 test failed") {
			t.Errorf("%s = %+v, want a note about the failing test", name, m)
		}
	}
	r.assertNothingLeft(t)
}

func TestANodeTestSuiteHasCoverageFromItsChildProcesses(t *testing.T) {
	original := copyProject(t, "node-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	cov := oneExecution(t, &r.set, "tests.coverage")
	if cov.Status != resultset.StatusCompleted {
		t.Fatalf("tests.coverage = %+v", cov)
	}
	suite := oneExecution(t, &r.set, "tests.existing")
	if !slices.Equal(suite.Command, cov.Command) || !slices.Contains(suite.Command, "--test") || !strings.HasSuffix(suite.Command[1], "/c8/bin/c8.js") {
		t.Errorf("commands = %v and %v, want one run of node --test wrapped by c8", suite.Command, cov.Command)
	}
	ms := coverageMetrics(&r.set)
	// Each test file runs in a child process of node --test. Both functions of
	// src/index.js are called there, and nothing in the parent calls them.
	for name, want := range map[string]float64{"functions": 100, "lines": 100} {
		m := ms[name]
		if m.Value == nil || *m.Value != want {
			t.Errorf("%s = %+v, want %v", name, m, want)
		}
		if m.Reason == nil || !strings.Contains(*m.Reason, "failed") {
			t.Errorf("%s = %+v, want the note of the failing test", name, m)
		}
	}
	doc := coverageFilesOf(t, r, cov)
	if len(doc.Files) != 1 || doc.Files[0].Path != "src/index.js" {
		t.Errorf("files = %+v, want only src/index.js", doc.Files)
	}
	r.assertNothingLeft(t)
}

func TestAProjectsOwnC8WrapperAndConfigAreNotUsedAndTheReportSaysSo(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	manifest := `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"c8 --reporter=text mocha"},"devDependencies":{"mocha":"^10.8.2"}}`
	if err := os.WriteFile(filepath.Join(original, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	// If this configuration were read, no file would be measured.
	if err := os.WriteFile(filepath.Join(original, ".c8rc.json"), []byte(`{"all":false,"include":["nothing/**"]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if m := coverageMetrics(&r.set)["functions"]; m.Value == nil || *m.Value != 50 {
		t.Errorf("function coverage = %+v, want 50 from our own configuration", m)
	}
	dropped := false
	for _, l := range r.set.Limitations {
		dropped = dropped || (l.ReasonCode == "test_wrapper_dropped" && strings.Contains(l.Message, "c8"))
	}
	if !dropped {
		t.Errorf("limitations = %+v, want the dropped c8 wrapper listed", r.set.Limitations)
	}
}
