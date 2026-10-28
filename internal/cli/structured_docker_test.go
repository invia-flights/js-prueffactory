//go:build docker

package cli_test

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// artifacts.structured is native, but the Run around it still goes through the
// whole command, so this test sits at seam A with the other Docker tests.
func TestBrokenStructuredFilesAreGatesExceptInTestData(t *testing.T) {
	original := copyProject(t, "broken-structured-files")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	var executions []resultset.Execution
	for _, e := range r.set.Checks {
		if e.CheckID == "artifacts.structured" {
			executions = append(executions, e)
		}
	}
	if len(executions) != 1 || executions[0].ContextID != "C-0001" || executions[0].Status != resultset.StatusCompleted {
		t.Fatalf("artifacts.structured executions = %+v, want one completed in the project Context", executions)
	}

	byPath := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "artifacts.structured") {
		byPath[f.Locations[0].Path] = f
	}
	// tsconfig.json (JSONC) and .gitlab-ci.yml (!reference) are accepted, so
	// exactly these three files have a Finding.
	if len(byPath) != 3 {
		t.Fatalf("findings by path = %v, want config/settings.json, deploy/values.yaml and test/fixtures/invalid.json", byPath)
	}

	json := byPath["config/settings.json"]
	if !json.Gate || json.Severity != resultset.SeverityError || json.InTestData || json.Title != "JSON file does not parse" {
		t.Errorf("config/settings.json should be a Gate: %+v", json)
	}
	if s := json.Locations[0].Start; s == nil || s.Line != 4 || s.Column == nil || *s.Column != 1 {
		t.Errorf("config/settings.json location = %+v, want 4:1", s)
	}

	yaml := byPath["deploy/values.yaml"]
	if !yaml.Gate || yaml.Title != "YAML file does not parse" {
		t.Errorf("deploy/values.yaml should be a Gate: %+v", yaml)
	}
	if s := yaml.Locations[0].Start; s == nil || s.Line != 3 {
		t.Errorf("deploy/values.yaml location = %+v, want line 3 (the tab-indented line)", s)
	}

	note := byPath["test/fixtures/invalid.json"]
	if note.Gate || note.Severity != resultset.SeverityNote || !note.InTestData {
		t.Errorf("a broken file in Test data should be a note: %+v", note)
	}
	if r.set.Summary.Gates != 2 {
		t.Errorf("gates = %d, want 2", r.set.Summary.Gates)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}
