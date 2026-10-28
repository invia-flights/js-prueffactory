//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for the rule groups of tests.smells,
// deps.engines and quality.metrics in the combined ESLint run.

func packageExecution(t *testing.T, r *dockerRun, check string) *resultset.Execution {
	t.Helper()
	for i := range r.set.Checks {
		if r.set.Checks[i].CheckID == check && r.set.Checks[i].ContextID == "C-0002" {
			return &r.set.Checks[i]
		}
	}
	t.Fatalf("no %s execution in the package Context\nstderr:\n%s", check, r.stderr)
	return nil
}

func TestACommittedOnlyIsAGateAndAPendingTestIsAWarning(t *testing.T) {
	original := copyProject(t, "committed-only")
	// node:test files are covered, because test is a test-case name and their
	// imports are followed.
	node := "import { test } from 'node:test';\n\ntest.only('focused', () => {});\n"
	if err := os.WriteFile(filepath.Join(original, "test", "node.test.mjs"), []byte(node), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1: a committed .only is a Gate\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := packageExecution(t, r, "tests.smells")
	if exec.Status != resultset.StatusCompleted || exec.Outcome != resultset.OutcomeFailed {
		t.Fatalf("tests.smells = %s / %s (%v), want completed and failed", exec.Status, exec.Outcome, exec.Reason)
	}

	got := map[string]string{}
	for _, f := range findingsOf(&r.set, "tests.smells") {
		gate := "warning"
		if f.Gate {
			gate = "gate"
		}
		got[*f.RuleID+"@"+f.Locations[0].Path] = gate
	}
	want := map[string]string{
		"mocha/no-exclusive-tests@test/add.test.js":   "gate",
		"mocha/no-exclusive-tests@test/node.test.mjs": "gate",
		"mocha/no-pending-tests@test/add.test.js":     "warning",
	}
	if len(got) != len(want) {
		t.Errorf("findings = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

func TestNewBufferIsAWarningOfDepsEnginesOnThePackagesNodeVersion(t *testing.T) {
	original := copyProject(t, "deprecations")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: deps.engines findings are warnings\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := packageExecution(t, r, "deps.engines")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("deps.engines = %s (%v)", exec.Status, exec.Reason)
	}
	found := findingsOf(&r.set, "deps.engines")
	if len(found) != 1 {
		t.Fatalf("findings = %+v, want the one new Buffer()", found)
	}
	f := found[0]
	if *f.RuleID != "n/no-deprecated-api" || f.Gate || f.Severity != resultset.SeverityWarning ||
		f.Locations[0].Path != "src/index.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 6 {
		t.Errorf("finding = %+v", f)
	}
	if !strings.Contains(f.Message, "new Buffer()") {
		t.Errorf("message = %q", f.Message)
	}
}

func TestOnlyTheRuleGroupsOfSelectedChecksAreSwitchedOn(t *testing.T) {
	original := copyProject(t, "deprecations")

	r := realRun(t, context.Background(), "test", original, "--only", "deps.engines")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if got := len(findingsOf(&r.set, "deps.engines")); got != 1 {
		t.Errorf("deps.engines findings = %d, want 1", got)
	}
	for _, f := range r.set.Findings {
		if f.CheckID != "deps.engines" {
			t.Errorf("finding of %s, but only deps.engines is selected", f.CheckID)
		}
	}
	// The config's hash covers the groups that were on, and there is no
	// measuring group among them.
	for _, c := range r.set.Contexts {
		for _, tool := range c.Tools {
			if tool.Name == "eslint-config" && tool.Digest == nil {
				t.Errorf("eslint-config tool without a digest: %+v", tool)
			}
		}
	}
}

func TestQualitySignalsComplexFunctionShowsUpAboveEveryThresholdAndNothingIsAGate(t *testing.T) {
	original := copyProject(t, "quality-signals")

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: metrics are measurements\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := packageExecution(t, r, "quality.metrics")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("quality.metrics = %s (%v)", exec.Status, exec.Reason)
	}
	if got := len(findingsOf(&r.set, "quality.metrics")); got != 0 {
		t.Errorf("findings = %d, want a measurement without Findings", got)
	}

	metrics := map[string]float64{}
	for _, m := range r.set.Metrics {
		if m.CheckID == "quality.metrics" {
			if m.Value == nil {
				t.Errorf("metric %s has no value: %v", m.Name, m.Reason)
				continue
			}
			metrics[m.Name] = *m.Value
		}
	}
	for _, name := range []string{"functions_above_cyclomatic_20", "functions_above_cognitive_15", "functions_above_length_50"} {
		if metrics[name] != 1 {
			t.Errorf("%s = %v, want 1: only shippingCost is that complex", name, metrics[name])
		}
	}
	if metrics["cyclomatic_max"] <= 20 || metrics["cognitive_max"] <= 15 || metrics["length_max"] <= 50 {
		t.Errorf("maxima = %v, want above every threshold", metrics)
	}
	// The functions of Source code have the 50th percentile below every
	// threshold. The long describe callback and the arrow functions in
	// test/*.test.js are Test code and are not measured.
	if metrics["functions"] < 5 || metrics["cyclomatic_p50"] >= 20 || metrics["length_p50"] >= 50 {
		t.Errorf("metrics = %v", metrics)
	}

	if len(exec.ArtifactIDs) != 1 {
		t.Fatalf("artifact IDs = %v, want the per-function values", exec.ArtifactIDs)
	}
	var artifact resultset.Artifact
	for _, a := range r.set.Artifacts {
		if a.ID == exec.ArtifactIDs[0] {
			artifact = a
		}
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(artifact.Path)))
	if err != nil {
		t.Fatalf("the artifact %+v is not in the report folder: %v", artifact, err)
	}
	var doc struct {
		Functions []struct {
			Path       string `json:"path"`
			Name       string `json:"name"`
			Cyclomatic int    `json:"cyclomatic"`
			Cognitive  int    `json:"cognitive"`
			Length     int    `json:"length"`
		} `json:"functions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	var shipping []string
	for _, f := range doc.Functions {
		if !strings.HasPrefix(f.Path, "src/") {
			t.Errorf("the artifact holds a function outside Source code: %s %s", f.Path, f.Name)
		}
		if f.Path == "src/shipping.js" {
			shipping = append(shipping, f.Name)
			if f.Cyclomatic <= 20 || f.Cognitive <= 15 || f.Length <= 50 {
				t.Errorf("shippingCost = %+v, want above every threshold", f)
			}
		}
	}
	sort.Strings(shipping)
	if len(shipping) != 1 || shipping[0] != "Function 'shippingCost'" {
		t.Errorf("functions of src/shipping.js = %v", shipping)
	}
	if r.set.Summary.Gates != 0 {
		t.Errorf("gates = %d", r.set.Summary.Gates)
	}
}
