package engine_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/engine"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// runWithout Docker: a project whose packages cannot be installed never starts
// a container, so prerequisites can be tested without a daemon.
func runPnpmProject(t *testing.T, only ...string) (*engine.Result, resultset.Set) {
	t.Helper()
	project := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"package.json": `{"name":"demo","devDependencies":{"mocha":"^10.0.0"}}`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	} {
		if err := os.WriteFile(filepath.Join(project, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sel, err := checks.ResolveCatalog(only, nil)
	if err != nil {
		t.Fatal(err)
	}
	reportDir := filepath.Join(t.TempDir(), "report")
	res, err := engine.Run(context.Background(), engine.Config{
		Command: "test", Original: project, ReportDir: reportDir,
		Formats: writer.Formats{JSON: true, Markdown: true},
		RunID:   "20261026T100000Z-demo-bbbb", Start: time.Now(), Budget: 30 * time.Minute, BudgetSource: "default",
		TempDir: t.TempDir(), Selection: sel, Log: progress.New(io.Discard, nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(reportDir, "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rep resultset.Set
	if err := json.Unmarshal(raw, &rep); err != nil {
		t.Fatal(err)
	}
	if problems := rep.Validate(); len(problems) != 0 {
		t.Fatalf("report is inconsistent: %v", problems)
	}
	return res, rep
}

func executionOf(t *testing.T, s resultset.Set, check string) resultset.Execution {
	t.Helper()
	for _, e := range s.Checks {
		if e.CheckID == check && e.Applicability != resultset.NotApplicable {
			return e
		}
	}
	t.Fatalf("no applicable execution of %s in %+v", check, s.Checks)
	return resultset.Execution{}
}

func TestOnlyDepsTreeRunsTheInstallAsAPrerequisite(t *testing.T) {
	res, rep := runPnpmProject(t, "deps.tree")

	install := executionOf(t, rep, "package.install")
	if install.Selected {
		t.Error("package.install was not selected, and the Report must say so")
	}
	if install.Status != resultset.StatusUnsupported {
		t.Errorf("package.install ran as a prerequisite and says %s; want unsupported for a pnpm project", install.Status)
	}
	if got := prerequisitesOf(rep); len(got) != 1 || got[0] != "package.install" {
		t.Errorf("prerequisites_run = %v", rep.Selection.PrerequisitesRun)
	}
	if len(rep.Selection.EffectiveChecks) != 1 || rep.Selection.EffectiveChecks[0] != "deps.tree" {
		t.Errorf("effective checks = %v: a prerequisite is not part of the Selection", rep.Selection.EffectiveChecks)
	}

	tree := executionOf(t, rep, "deps.tree")
	if !tree.Selected || tree.Status != resultset.StatusUnsupported ||
		tree.ReasonCode == nil || *tree.ReasonCode != "package_manager_unsupported" || tree.Reason == nil {
		t.Errorf("deps.tree = %+v, want unsupported with the install's reason code", tree)
	}
	// The prerequisite reports no Findings of its own and no Gates.
	if len(rep.Findings) != 0 || rep.Summary.Gates != 0 {
		t.Errorf("findings = %+v", rep.Findings)
	}
	// Only deps.tree is in the Selection, and it did not complete.
	if res.ExitCode != 2 {
		t.Errorf("exit code = %d, want 2", res.ExitCode)
	}
}

// prerequisitesOf is prerequisites_run without the secret scan, which every Run
// performs for the sake of redaction whatever is selected.
func prerequisitesOf(s resultset.Set) []string {
	var out []string
	for _, id := range s.Selection.PrerequisitesRun {
		if id != checks.SecretsCheckID {
			out = append(out, id)
		}
	}
	return out
}

func TestASelectedInstallIsNoPrerequisiteRunWithoutSelection(t *testing.T) {
	_, rep := runPnpmProject(t, "package.install")
	if len(prerequisitesOf(rep)) != 0 {
		t.Errorf("prerequisites_run = %v", rep.Selection.PrerequisitesRun)
	}
	install := executionOf(t, rep, "package.install")
	if !install.Selected || install.Status != resultset.StatusUnsupported {
		t.Errorf("package.install = %+v", install)
	}
	// deps.tree is not selected and nothing selected needs it.
	for _, e := range rep.Checks {
		if e.CheckID == "deps.tree" && e.Status != resultset.StatusNotStarted {
			t.Errorf("deps.tree = %+v, want not started", e)
		}
	}
}

func TestSelectingBothRunsEachOnceAndReportsNoPrerequisite(t *testing.T) {
	_, rep := runPnpmProject(t, "package.install,deps.tree")
	if len(prerequisitesOf(rep)) != 0 {
		t.Errorf("prerequisites_run = %v", rep.Selection.PrerequisitesRun)
	}
	if e := executionOf(t, rep, "package.install"); !e.Selected {
		t.Errorf("package.install = %+v", e)
	}
}
