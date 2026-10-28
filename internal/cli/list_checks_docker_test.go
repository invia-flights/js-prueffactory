//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The Selection is recorded in the Report, and the Checks it leaves out show up
// as deselected without changing the exit code. The assertions follow from the
// implemented Catalog, so they hold while more Checks get implemented.
func TestOnlyRecordsTheSelectionAndReportsDeselectedChecks(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "syntax.parse")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	sel := r.set.Selection
	if !slices.Equal(sel.Only, []string{"syntax.parse"}) || len(sel.Exclude) != 0 || !slices.Equal(sel.EffectiveChecks, []string{"syntax.parse"}) {
		t.Errorf("selection = %+v", sel)
	}
	var others []string
	for _, id := range checks.ImplementedIDs() {
		if id != "syntax.parse" {
			others = append(others, id)
		}
	}
	if !slices.Equal(sel.DeselectedChecks, others) || sel.IsStandardScope != (len(others) == 0) {
		t.Errorf("deselected %v (want %v), is_standard_scope %v", sel.DeselectedChecks, others, sel.IsStandardScope)
	}

	deselected := map[string]bool{}
	for _, e := range r.set.Checks {
		if e.Selected {
			if e.CheckID != "syntax.parse" || e.Status != resultset.StatusCompleted {
				t.Errorf("selected execution = %+v", e)
			}
			continue
		}
		deselected[e.CheckID] = true
		if e.Status != resultset.StatusNotStarted || e.ReasonCode == nil || *e.ReasonCode != "deselected" {
			t.Errorf("deselected execution = %+v", e)
		}
	}
	for _, id := range others {
		if !deselected[id] {
			t.Errorf("%s is not in the Report as deselected", id)
		}
	}

	scope, std := r.set.Summary.ScopeCompleteness, r.set.Summary.StandardCompleteness
	if scope.Required != 1 || scope.Completed != 1 {
		t.Errorf("scope completeness = %+v", scope)
	}
	if len(others) == 0 && (std.Required != scope.Required || std.Completed != scope.Completed) || len(others) > 0 && std.Completed != 1 {
		t.Errorf("standard completeness = %+v, scope %+v", std, scope)
	}

	md, _ := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if !strings.Contains(string(md), "Scope completeness: 1 of 1") {
		t.Errorf("report.md result line does not show Scope completeness:\n%s", md)
	}
	if len(others) > 0 && !strings.Contains(string(md), "deselected") {
		t.Error("report.md does not list the deselected Checks")
	}
	r.assertNothingLeft(t)
}

func TestFullRunRecordsStandardScope(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original)

	sel := r.set.Selection
	if !sel.IsStandardScope || len(sel.DeselectedChecks) != 0 || len(sel.Only) != 0 || len(sel.Exclude) != 0 ||
		!slices.Equal(sel.EffectiveChecks, checks.ImplementedIDs()) {
		t.Errorf("selection = %+v", sel)
	}
	if std, scope := r.set.Summary.StandardCompleteness, r.set.Summary.ScopeCompleteness; std.Required != scope.Required || std.Completed != scope.Completed {
		t.Errorf("standard %+v differs from scope %+v in a full Run", r.set.Summary.StandardCompleteness, r.set.Summary.ScopeCompleteness)
	}
	r.assertNothingLeft(t)
}
