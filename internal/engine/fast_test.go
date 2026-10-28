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

// A Check that --fast left out is reported as deselected by --fast, one that
// --exclude left out as plain deselected, and the Report records that --fast
// was used. The Selection is hand-built so the test does not depend on which
// Checks are marked or implemented today.
func TestFastIsRecordedAndNamedAsTheReasonOfTheChecksItLeftOut(t *testing.T) {
	project := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"package.json": `{"name":"demo"}`, "index.js": "module.exports = 1;\n"} {
		if err := os.WriteFile(filepath.Join(project, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	sel := &checks.Selection{
		Exclude:    []string{"package.manifest"},
		Deselected: []string{"package.manifest", "syntax.parse"}, DeselectedByFast: []string{"syntax.parse"},
		Fast: true,
	}
	reportDir := filepath.Join(t.TempDir(), "report")
	if _, err := engine.Run(context.Background(), engine.Config{
		Command: "test", Original: project, ReportDir: reportDir,
		Formats: writer.Formats{JSON: true},
		RunID:   "20261027T100000Z-demo-aaaa", Start: time.Now(), Budget: 30 * time.Minute, BudgetSource: "fast_default",
		TempDir:   t.TempDir(),
		Selection: sel,
		Log:       progress.New(io.Discard, nil),
	}); err != nil {
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
	if !rep.Selection.Fast {
		t.Error("selection.fast is false for a --fast Run")
	}
	if rep.SchemaVersion != "0.4.0" || rep.Profiles.CatalogVersion != "milestone-2" || rep.Profiles.ExecutionProfile != "execution-v1" {
		t.Errorf("schema %q, Catalog version %q, execution profile %q", rep.SchemaVersion, rep.Profiles.CatalogVersion, rep.Profiles.ExecutionProfile)
	}
	if rep.Run.BudgetSource != "fast_default" {
		t.Errorf("budget source = %q", rep.Run.BudgetSource)
	}
	want := map[string]string{"syntax.parse": "deselected_by_fast", "package.manifest": "deselected"}
	for _, e := range rep.Checks {
		code, ok := want[e.CheckID]
		if !ok || e.Selected {
			continue
		}
		if e.ReasonCode == nil || *e.ReasonCode != code {
			t.Errorf("%s: reason code = %v, want %s", e.CheckID, e.ReasonCode, code)
		}
		delete(want, e.CheckID)
	}
	if len(want) != 0 {
		t.Errorf("no deselected execution found for %v", want)
	}
}
