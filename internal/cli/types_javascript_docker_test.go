//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for types.javascript.

func TestTypesJavascriptWarnsAboutAJSDocMismatchAndIgnoresTheProjectsOwnTsconfig(t *testing.T) {
	original := copyProject(t, "types-jsdoc")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: type errors are warnings and never Gates\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}

	exec := oneExecution(t, &r.set, "types.javascript")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("types.javascript = %+v\nstderr:\n%s", exec, r.stderr)
	}
	if exec.Tool == nil || exec.Tool.Name != "tsc" || exec.Tool.Version == nil || *exec.Tool.Version != "7.0.2" {
		t.Errorf("tool = %+v, want TypeScript 7.0.2", exec.Tool)
	}
	if command := strings.Join(exec.Command, " "); !strings.Contains(command, "--pretty false") || !strings.Contains(command, "-p /jspf/tsconfig.json") {
		t.Errorf("command = %q", command)
	}

	// The package.install prerequisite ran although it was not selected.
	found := false
	for _, id := range r.set.Selection.PrerequisitesRun {
		found = found || id == "package.install"
	}
	if !found {
		t.Errorf("prerequisites_run = %v", r.set.Selection.PrerequisitesRun)
	}

	// Exactly the planted errors: Node's types (require, process, node:os) come
	// from the toolset because the project has none of its own, and the
	// extensionless require of data/schema.json resolves like it does in Node.
	got := findingsOf(&r.set, "types.javascript")
	if len(got) != 2 {
		t.Fatalf("findings = %+v, want the JSDoc mismatch and the one missing module", got)
	}
	sort.Slice(got, func(i, j int) bool { return got[i].Locations[0].Start.Line < got[j].Locations[0].Start.Line })
	f := got[0]
	if f.RuleID == nil || *f.RuleID != "TS2345" || f.Gate || f.Severity != resultset.SeverityWarning {
		t.Errorf("finding = %+v, want a TS2345 warning without Gate", f)
	}
	if f.Locations[0].Path != "src/index.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 14 {
		t.Errorf("location = %+v", f.Locations[0])
	}
	// A module that exists neither as .js nor as .json stays a Finding.
	m := got[1]
	if m.RuleID == nil || *m.RuleID != "TS2307" || m.Gate || m.Severity != resultset.SeverityWarning {
		t.Errorf("finding = %+v, want a TS2307 warning without Gate", m)
	}
	if m.Locations[0].Path != "src/index.js" || m.Locations[0].Start == nil || m.Locations[0].Start.Line != 21 {
		t.Errorf("location = %+v", m.Locations[0])
	}

	// What the JSON filter dropped stays visible: the extensionless require of
	// data/schema.json is counted and listed, and is not a resolution error.
	for _, mt := range r.set.Metrics {
		if mt.CheckID != "types.javascript" || mt.Value == nil {
			continue
		}
		switch {
		case mt.Name == "json_modules_dropped" && *mt.Value != 1:
			t.Errorf("json_modules_dropped = %v, want 1", *mt.Value)
		case mt.Name == "resolution_errors" && *mt.Value != 1:
			t.Errorf("resolution_errors = %v, want 1: only ./data/missing", *mt.Value)
		}
	}
	list := artifactOf(&r.set, exec, "C-0002-json-modules-dropped.json")
	if list == nil {
		t.Fatalf("no list of dropped JSON requires: %+v", r.set.Artifacts)
	}
	listed, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(list.Path)))
	if err != nil || !strings.Contains(string(listed), `"specifier": "./data/schema"`) || !strings.Contains(string(listed), `"path": "src/index.js"`) ||
		!strings.Contains(string(listed), `"line": 17`) || !strings.Contains(string(listed), `"resolves_to": "src/data/schema.json"`) {
		t.Errorf("list of dropped JSON requires = %v %q", err, listed)
	}

	// The generated config is an artifact of the Report.
	artifact := artifactOf(&r.set, exec, "C-0002-tsconfig.json")
	if artifact == nil {
		t.Fatalf("no tsconfig artifact: %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(artifact.Path)))
	if err != nil || !strings.Contains(string(data), `"checkJs": true`) || !strings.Contains(string(data), "/work/src/index.js") {
		t.Errorf("tsconfig artifact = %v %q", err, data)
	}
}

func TestAPackageWithATypeScriptSourceFileIsCheckedNotUnsupported(t *testing.T) {
	original := copyProject(t, "typescript-source")

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: a TypeScript file no longer leaves the Run incomplete\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := oneExecution(t, &r.set, "types.javascript")
	if exec.Status != resultset.StatusCompleted || exec.ReasonCode != nil {
		t.Errorf("types.javascript = %+v, want completed", exec)
	}
	if len(findingsOf(&r.set, "types.javascript")) != 0 {
		t.Errorf("findings = %+v, want none: the interface in shape.ts is correct", r.set.Findings)
	}
	artifact := artifactOf(&r.set, exec, "C-0002-tsconfig.json")
	if artifact == nil {
		t.Fatalf("no tsconfig artifact: %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(artifact.Path)))
	if err != nil || !strings.Contains(string(data), "/work/src/shape.ts") || !strings.Contains(string(data), `"jsx"`) {
		t.Errorf("tsconfig artifact = %v %q, want shape.ts listed and jsx set", err, data)
	}
}

func TestTypesJavascriptWarnsInJavaScriptAndTypeScriptFilesOfAMostlyJavaScriptPackage(t *testing.T) {
	original := copyProject(t, "types-mixed-ts")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript,syntax.parse")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: type errors are warnings and the editor tsconfig is no build step\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	// syntax.parse still checks the JavaScript that runs.
	if exec := oneExecution(t, &r.set, "syntax.parse"); exec.Status != resultset.StatusCompleted {
		t.Errorf("syntax.parse = %+v, want completed", exec)
	}
	exec := oneExecution(t, &r.set, "types.javascript")
	if exec.Status != resultset.StatusCompleted || exec.ReasonCode != nil {
		t.Fatalf("types.javascript = %+v, want completed and not unsupported\nstderr:\n%s", exec, r.stderr)
	}

	got := findingsOf(&r.set, "types.javascript")
	if len(got) != 2 {
		t.Fatalf("findings = %+v, want the JSDoc mismatch and the TypeScript error", got)
	}
	byPath := map[string]resultset.Finding{}
	for _, f := range got {
		if f.Gate || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceSuspected || f.RuleID == nil {
			t.Errorf("finding = %+v, want a suspected warning without Gate", f)
		}
		byPath[f.Locations[0].Path] = f
	}
	if f, ok := byPath["src/index.js"]; !ok || *f.RuleID != "TS2345" || f.Locations[0].Start.Line != 12 {
		t.Errorf("JavaScript finding = %+v", byPath)
	}
	if f, ok := byPath["src/shape.ts"]; !ok || *f.RuleID != "TS2322" || f.Locations[0].Start.Line != 5 {
		t.Errorf("TypeScript finding = %+v", byPath)
	}
	if len(r.set.Limitations) != 0 {
		for _, l := range r.set.Limitations {
			if l.ReasonCode == "project_tsconfig_not_used" {
				t.Errorf("limitation = %+v, want none for two plain type errors", l)
			}
		}
	}
}

func TestTypesJavascriptParsesTsxFiles(t *testing.T) {
	original := copyProject(t, "types-tsx")

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	exec := oneExecution(t, &r.set, "types.javascript")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("types.javascript = %+v\nstderr:\n%s", exec, r.stderr)
	}
	got := findingsOf(&r.set, "types.javascript")
	// Only the planted mismatch: the JSX parses and raises no syntax error (TS1xxx).
	if len(got) != 1 || got[0].RuleID == nil || *got[0].RuleID != "TS2322" ||
		got[0].Locations[0].Path != "src/view.tsx" || got[0].Locations[0].Start.Line != 2 {
		t.Errorf("findings = %+v, want the one TS2322 in src/view.tsx", got)
	}
}

func TestTypeScriptThatNeedsABuildStepStaysUnsupportedForTypesAndSyntaxParse(t *testing.T) {
	original := copyProject(t, "typescript-build-step")

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript,syntax.parse")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2: selected Checks that are unsupported leave the Run incomplete\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	for _, id := range []string{"types.javascript", "syntax.parse"} {
		exec := oneExecution(t, &r.set, id)
		if exec.Status != resultset.StatusUnsupported || exec.ReasonCode == nil || *exec.ReasonCode != "build_step_required" ||
			exec.Reason == nil || !strings.Contains(*exec.Reason, "outDir") {
			t.Errorf("%s = %+v, want unsupported with the build step and its sign named", id, exec)
		}
	}
	if len(findingsOf(&r.set, "types.javascript")) != 0 {
		t.Errorf("findings = %+v", r.set.Findings)
	}
}

func TestTypesJavascriptNamesTheMissingProjectTsconfigWhenPathAliasesFloodTheFindings(t *testing.T) {
	original := copyProject(t, "types-path-aliases")

	r := realRun(t, context.Background(), "test", original, "--only", "types.javascript")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	exec := oneExecution(t, &r.set, "types.javascript")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("types.javascript = %+v\nstderr:\n%s", exec, r.stderr)
	}
	got := findingsOf(&r.set, "types.javascript")
	if len(got) != 6 {
		t.Fatalf("findings = %+v, want six unresolved imports", got)
	}
	for _, f := range got {
		if f.RuleID == nil || *f.RuleID != "TS2307" || f.Severity != resultset.SeverityWarning || f.Gate {
			t.Errorf("finding = %+v, want a TS2307 warning without Gate", f)
		}
	}
	var limitation *resultset.Limitation
	for i, l := range r.set.Limitations {
		if l.ReasonCode == "project_tsconfig_not_used" {
			limitation = &r.set.Limitations[i]
		}
	}
	if limitation == nil || limitation.CheckID == nil || *limitation.CheckID != "types.javascript" ||
		!strings.Contains(limitation.Message, "6 of 6") || !strings.Contains(limitation.Message, "tsconfig") {
		t.Fatalf("limitations = %+v, want one that names the missing project tsconfig", r.set.Limitations)
	}
	var metric *resultset.Metric
	for i, m := range r.set.Metrics {
		if m.CheckID == "types.javascript" && m.Name == "resolution_errors" {
			metric = &r.set.Metrics[i]
		}
	}
	if metric == nil || metric.Value == nil || *metric.Value != 6 {
		t.Errorf("metrics = %+v, want resolution_errors = 6", r.set.Metrics)
	}
}
