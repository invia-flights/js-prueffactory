//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon and the public npm registry, for
// lint.existing: the project's own ESLint and Biome at their locked versions.

func lintFindingsByRule(s *resultset.Set) map[string]resultset.Finding {
	out := map[string]resultset.Finding{}
	for _, f := range findingsOf(s, "lint.existing") {
		out[*f.RuleID] = f
	}
	return out
}

func TestLintExistingRunsTheProjectsOwnESLintWithItsConfigAndDirectivesAndFiresAGateForAnErrorRule(t *testing.T) {
	original := copyProject(t, "project-eslint")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "lint.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 for the Gate\nstderr:\n%s", r.code, r.stderr)
	}
	exec := oneExecution(t, &r.set, "lint.existing")
	if exec.Status != resultset.StatusCompleted || exec.Outcome != resultset.OutcomeFailed || exec.Gate != 1 {
		t.Fatalf("lint.existing = %+v, want completed with one Gate", exec)
	}
	if exec.Tool == nil || exec.Tool.Name != "eslint" || exec.Tool.Version == nil || !strings.HasPrefix(*exec.Tool.Version, "9.") {
		t.Errorf("tool = %+v, want the project's own ESLint 9 from the lockfile, not the toolset's", exec.Tool)
	}
	if got := strings.Join(exec.Command, " "); got != "node node_modules/eslint/bin/eslint.js --format json ." {
		t.Errorf("command = %q", got)
	}

	byRule := lintFindingsByRule(&r.set)
	unused, ok := byRule["no-unused-vars"]
	if !ok || !unused.Gate || unused.Severity != resultset.SeverityError || unused.Locations[0].Path != "src/index.js" || unused.Locations[0].Start.Line != 1 {
		t.Errorf("no-unused-vars = %+v, want a Gate at src/index.js:1", unused)
	}
	if eq, ok := byRule["eqeqeq"]; !ok || eq.Gate || eq.Severity != resultset.SeverityWarning {
		t.Errorf("eqeqeq = %+v, want a warning", eq)
	}
	if _, ok := byRule["no-console"]; ok {
		t.Error("the project's own eslint-disable comment keeps its meaning: no-console is silenced")
	}
	if len(byRule) != 2 {
		t.Errorf("findings = %v", byRule)
	}
	if artifactOf(&r.set, exec, "linters.json") == nil {
		t.Errorf("no linters.json artifact: %+v", r.set.Artifacts)
	}
	// The install ran as a prerequisite and is reported as not selected.
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 1 || got[0] != "package.install" {
		t.Errorf("prerequisites_run = %v", r.set.Selection.PrerequisitesRun)
	}
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestLintExistingRunsBiomeAndRetriesWithoutVCSWhenItsIgnoreFileCannotBeFound(t *testing.T) {
	original := copyProject(t, "project-biome")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 for the Gate\nstderr:\n%s", r.code, r.stderr)
	}
	exec := oneExecution(t, &r.set, "lint.existing")
	if exec.Status != resultset.StatusCompleted || exec.Gate != 1 {
		t.Fatalf("lint.existing = %+v, want completed with one Gate", exec)
	}
	if exec.Tool == nil || exec.Tool.Name != "biome" || exec.Tool.Version == nil || *exec.Tool.Version != "2.1.2" {
		t.Errorf("tool = %+v, want the project's Biome 2.1.2", exec.Tool)
	}
	if got := strings.Join(exec.Command, " "); got != "node node_modules/@biomejs/biome/bin/biome lint --vcs-enabled=false --reporter=json ." {
		t.Errorf("command = %q, want the retry that produced the result", got)
	}

	byRule := lintFindingsByRule(&r.set)
	debugger, ok := byRule["lint/suspicious/noDebugger"]
	if !ok || !debugger.Gate || debugger.Locations[0].Path != "src/index.js" || debugger.Locations[0].Start.Line != 2 {
		t.Errorf("noDebugger = %+v, want a Gate at src/index.js:2", debugger)
	}
	if console, ok := byRule["lint/suspicious/noConsole"]; !ok || console.Gate || console.Severity != resultset.SeverityWarning {
		t.Errorf("noConsole = %+v, want a warning", console)
	}
	if unused, ok := byRule["lint/correctness/noUnusedVariables"]; !ok || unused.Gate {
		t.Errorf("noUnusedVariables = %+v, want a warning", unused)
	}

	var override bool
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "biome_vcs_disabled" && l.CheckID != nil && *l.CheckID == "lint.existing" {
			override = true
		}
	}
	if !override {
		t.Errorf("limitations = %+v, want the VCS override recorded", r.set.Limitations)
	}
	artifact := artifactOf(&r.set, exec, "linters.json")
	if artifact == nil {
		t.Fatalf("no linters.json artifact: %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(artifact.Path)))
	if err != nil || !strings.Contains(string(data), "--vcs-enabled=false") || !strings.Contains(string(data), `"override"`) {
		t.Errorf("linters.json = %v %s", err, data)
	}
	r.assertNothingLeft(t)
}

func TestLintExistingReportsALegacyESLintConfigWithESLint10AsAProjectError(t *testing.T) {
	original := copyProject(t, "eslint-legacy")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 for the project error\nstderr:\n%s", r.code, r.stderr)
	}
	exec := oneExecution(t, &r.set, "lint.existing")
	if exec.Status != resultset.StatusCompleted || exec.Gate != 1 {
		t.Fatalf("lint.existing = %+v, want completed with one Gate", exec)
	}
	f, ok := lintFindingsByRule(&r.set)["eslint-legacy-config"]
	if !ok || !f.Gate || f.Locations[0].Path != ".eslintrc.json" {
		t.Fatalf("findings = %+v, want eslint-legacy-config on .eslintrc.json", r.set.Findings)
	}
	if !strings.Contains(f.Message, "ESLint 10.") || !strings.Contains(f.Message, "eslint.config") {
		t.Errorf("message = %q, want the reason", f.Message)
	}
	r.assertNothingLeft(t)
}

func TestLintExistingIsNotApplicableToAPackageWithNeitherLinter(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.existing")

	if got := executionsOf(&r.set, "lint.existing"); len(got) != 0 {
		t.Errorf("executions = %+v, want none: clean-mocha has neither ESLint nor Biome", got)
	}
	r.assertNothingLeft(t)
}
