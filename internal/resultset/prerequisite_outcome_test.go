package resultset_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A prerequisite that ran without being selected reports no Findings, so a
// failure it had cannot show as a Gate. Its Outcome must still not read as
// passed: it carries a reason code, and its Outcome is unknown.
func TestAnUnselectedPrerequisiteThatFailedHasOutcomeUnknownNotPassed(t *testing.T) {
	reason := "prerequisite_failed_project"
	s := &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Run:       resultset.Run{Status: resultset.RunCompleted},
		Benchmark: resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		Contexts:  []resultset.Context{{ID: "C-0001", Kind: "project", Path: "."}, {ID: "C-0002", Kind: "package", Path: "."}},
		Checks: []resultset.Execution{
			{ID: "x1", CheckID: "package.install", Family: "package", ContextID: "C-0002",
				Selected: false, Applicability: resultset.Applicable, Status: resultset.StatusCompleted, ReasonCode: &reason},
			{ID: "x2", CheckID: "package.manifest", Family: "package", ContextID: "C-0002",
				Selected: false, Applicability: resultset.Applicable, Status: resultset.StatusCompleted},
		},
	}

	s.Finalize()

	for _, e := range s.Checks {
		want := resultset.OutcomePassed
		if e.CheckID == "package.install" {
			want = resultset.OutcomeUnknown
		}
		if e.Outcome != want {
			t.Errorf("%s: outcome %s, want %s", e.CheckID, e.Outcome, want)
		}
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Errorf("problems: %v", problems)
	}
}
