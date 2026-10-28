package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// unparseableOpenAPI has a C0 control character, which YAML 1.2 forbids and Redocly rejects.
const unparseableOpenAPI = "openapi: 3.0.3\ninfo:\n  title: Orders\n  version: \"1.0.0\"\n  description: \"broken \u0001 here\"\npaths: {}\n"

// TestAnOpenAPIFileThatArtifactsStructuredReportsIsSkippedWithALimitation runs
// api.lint without Docker: the only file is skipped, so no container starts.
func TestAnOpenAPIFileThatArtifactsStructuredReportsIsSkippedWithALimitation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "openapi.yaml"), []byte(unparseableOpenAPI), 0o644); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	impl := checks.Implementation("api.lint")
	if app, _ := impl.Applicability(proj, &proj.Contexts[0]); app != resultset.Applicable {
		t.Fatalf("applicability = %s, want applicable", app)
	}

	res := impl.Run(context.Background(), &checks.Input{
		Project: proj, Context: &proj.Contexts[0], OriginalPath: dir, SnapshotDir: dir,
		Selection: &checks.Selection{Effective: []string{"api.lint", "artifacts.structured"}},
	})

	if res.Status != resultset.StatusCompleted || res.ReasonCode != "" {
		t.Errorf("status = %s reason %q %q, want completed", res.Status, res.ReasonCode, res.Reason)
	}
	if len(res.Findings) != 0 {
		t.Errorf("no second Gate is added: %+v", res.Findings)
	}
	if len(res.Limitations) != 1 {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	l := res.Limitations[0]
	if l.ReasonCode != "file_not_parseable" || l.Path == nil || *l.Path != "openapi.yaml" || l.CheckID == nil || *l.CheckID != "api.lint" {
		t.Errorf("limitation = %+v", l)
	}
	if !strings.Contains(l.Message, "artifacts.structured") {
		t.Errorf("the message should point to artifacts.structured: %q", l.Message)
	}
}
