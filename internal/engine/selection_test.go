package engine_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/engine"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// A Run whose Selection leaves out every applicable Check starts no container
// of its own, so the Report of a deselected Check can be tested without Docker.
// The secret scan still wants to run as a prerequisite of redaction; without a
// Docker driver it fails, and the Report says so.
func TestDeselectedChecksAreReportedAndDoNotChangeTheExitCode(t *testing.T) {
	project := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(project, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{"name":"demo"}`)
	write("index.js", "module.exports = 1;\n")

	// A Selection that deselects syntax.parse, which applies to this project.
	// Hand-built, so the test does not depend on which other Checks exist.
	sel := &checks.Selection{
		Only: []string{"some.other"}, Exclude: []string{"syntax"},
		Deselected: []string{"syntax.parse"},
	}
	reportDir := filepath.Join(t.TempDir(), "report")
	res, err := engine.Run(context.Background(), engine.Config{
		Command: "test", Original: project, ReportDir: reportDir,
		Formats: writer.Formats{JSON: true, Markdown: true},
		RunID:   "20261026T100000Z-demo-aaaa", Start: time.Now(), Budget: 30 * time.Minute, BudgetSource: "default",
		TempDir:   t.TempDir(),
		Selection: sel,
		Log:       progress.New(io.Discard, nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 {
		t.Errorf("exit code = %d, a deselected Check must never change it", res.ExitCode)
	}

	raw, err := os.ReadFile(filepath.Join(reportDir, "report.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rep resultset.Set
	if err := json.Unmarshal(raw, &rep); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, e := range rep.Checks {
		if e.CheckID != "syntax.parse" {
			continue
		}
		found = true
		if e.Selected || e.Status != resultset.StatusNotStarted {
			t.Errorf("syntax.parse: selected=%v status=%s, want selected=false not_started", e.Selected, e.Status)
		}
		if e.Applicability != resultset.Applicable {
			t.Errorf("syntax.parse applicability = %s; a deselected Check keeps the Applicability discovery found", e.Applicability)
		}
		if e.ReasonCode == nil || *e.ReasonCode != "deselected" {
			t.Errorf("reason code = %v", e.ReasonCode)
		}
	}
	if !found {
		t.Fatal("the deselected Check is missing from checks")
	}

	s := rep.Selection
	if s.IsStandardScope || len(s.Only) != 1 || s.Only[0] != "some.other" || len(s.Exclude) != 1 || s.Exclude[0] != "syntax" ||
		len(s.DeselectedChecks) != 1 || s.DeselectedChecks[0] != "syntax.parse" || len(s.EffectiveChecks) != 0 {
		t.Errorf("selection = %+v", s)
	}

	if len(s.PrerequisitesRun) != 1 || s.PrerequisitesRun[0] != "security.secrets" {
		t.Errorf("prerequisites_run = %v, want the secret scan", s.PrerequisitesRun)
	}
	if red := rep.ReportCompleteness.Redaction; red.Applied || red.Reason == nil || !strings.Contains(*red.Reason, "did not complete") {
		t.Errorf("redaction = %+v, want not applied with a reason", red)
	}

	// Scope counts what was selected, Standard counts every applicable Check.
	if c := rep.Summary.ScopeCompleteness; c.Required != 0 || c.Completed != 0 {
		t.Errorf("scope completeness = %+v", c)
	}
	if c := rep.Summary.StandardCompleteness; c.Required < 1 || c.Completed != 0 {
		t.Errorf("standard completeness = %+v, want the deselected applicable Check required and not completed", c)
	}

	md, err := os.ReadFile(filepath.Join(reportDir, "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(md), "deselected") || !strings.Contains(string(md), "Scope completeness: 0 of 0") {
		t.Errorf("report.md does not show the deselection and Scope completeness:\n%s", md)
	}
}
