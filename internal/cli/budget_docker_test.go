//go:build docker

package cli_test

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestATinyBudgetLeavesEveryCheckBudgetExhaustedAndTheRunIncomplete(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	// The last 60 seconds of any Budget are reserved for the Report, so a
	// one-second Budget has no time for any Check.
	r := realRun(t, context.Background(), "test", original, "--budget", "1s")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", r.code, r.stderr)
	}
	if r.set.Run.Status != resultset.RunIncomplete {
		t.Errorf("run status = %q, want incomplete", r.set.Run.Status)
	}
	if r.set.Run.BudgetSeconds != 1 || r.set.Run.BudgetSource != "flag" {
		t.Errorf("Budget recorded as %ds from %q", r.set.Run.BudgetSeconds, r.set.Run.BudgetSource)
	}
	applicable := 0
	for _, e := range r.set.Checks {
		if e.Applicability == resultset.NotApplicable {
			continue
		}
		applicable++
		if e.Status != resultset.StatusBudgetExhausted || e.Outcome == resultset.OutcomePassed {
			t.Errorf("%s in %s: status %q, outcome %q", e.CheckID, e.ContextID, e.Status, e.Outcome)
		}
	}
	if applicable == 0 {
		t.Fatal("the project has no applicable Check, so the test proves nothing")
	}
	r.assertNothingLeft(t)
}

func TestFastRunOfCleanMochaRecordsFastAndTheFastDefaultBudget(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--fast")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", r.code, r.stderr)
	}
	if r.set.Run.BudgetSeconds != 1800 || r.set.Run.BudgetSource != "fast_default" {
		t.Errorf("Budget recorded as %ds from %q", r.set.Run.BudgetSeconds, r.set.Run.BudgetSource)
	}
	if !r.set.Selection.Fast {
		t.Error("selection.fast is false for a --fast Run")
	}
	if r.set.SchemaVersion != "0.4.0" || r.set.Profiles.CatalogVersion != "milestone-2" || r.set.Profiles.ExecutionProfile != "execution-v1" {
		t.Errorf("schema %q, Catalog %q, execution profile %q", r.set.SchemaVersion, r.set.Profiles.CatalogVersion, r.set.Profiles.ExecutionProfile)
	}
	// Every Check marked for --fast is still planned, so nothing is left out.
	if len(r.set.Selection.DeselectedChecks) != 0 {
		t.Errorf("deselected = %v", r.set.Selection.DeselectedChecks)
	}
	r.assertNothingLeft(t)

	plain := realRun(t, context.Background(), "test", copyProject(t, "clean-mocha"))
	if plain.set.Run.BudgetSeconds != 7200 || plain.set.Run.BudgetSource != "default" || plain.set.Selection.Fast {
		t.Errorf("a plain Run: Budget %ds from %q, fast %v", plain.set.Run.BudgetSeconds, plain.set.Run.BudgetSource, plain.set.Selection.Fast)
	}
	plain.assertNothingLeft(t)
}
