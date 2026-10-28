package resultset_test

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func ptr[T any](v T) *T { return &v }

// handMade returns a small result set with two executions and three Findings.
// Executions and Findings carry temporary keys, as the engine hands them over.
func handMade() *resultset.Set {
	finding := func(key, path, msg string, gate bool, sev resultset.Severity) resultset.Finding {
		return resultset.Finding{
			ID: key, CheckID: "syntax.parse", ExecutionID: "tmp-b", ContextID: "C-0003",
			RuleID: ptr("SyntaxError"), Kind: resultset.KindDefect, Severity: sev,
			Confidence: resultset.ConfidenceConfirmed, Gate: gate,
			Title: "Syntax error", Message: msg,
			Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: path,
				Start: &resultset.Position{Line: 1}, FileSHA256: strings.Repeat("a", 64)}},
			Fingerprint: resultset.Fingerprint{Algorithm: resultset.FingerprintV1, Value: key},
			Evidence:    []resultset.Evidence{}, Limitations: []string{},
		}
	}
	return &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Run:       resultset.Run{Status: resultset.RunCompleted},
		Benchmark: resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		Contexts: []resultset.Context{
			{ID: "C-0001", Kind: "project", Path: "."},
			{ID: "C-0002", Kind: "package", Path: "."},
			{ID: "C-0003", Kind: "package", Path: "sub"},
		},
		Checks: []resultset.Execution{
			{ID: "tmp-b", CheckID: "syntax.parse", Family: "syntax", ContextID: "C-0003",
				Selected: true, Applicability: resultset.Applicable, Status: resultset.StatusCompleted},
			{ID: "tmp-a", CheckID: "syntax.parse", Family: "syntax", ContextID: "C-0002",
				Selected: true, Applicability: resultset.Applicable, Status: resultset.StatusCompleted},
		},
		Findings: []resultset.Finding{
			finding("k1", "z.js", "late note", false, resultset.SeverityNote),
			finding("k2", "b.js", "gate b", true, resultset.SeverityError),
			finding("k3", "a.js", "gate a", true, resultset.SeverityError),
		},
	}
}

func TestFinalizeAssignsIDsInStableOrderWhateverTheArrivalOrder(t *testing.T) {
	a := handMade()
	b := handMade()
	slices.Reverse(b.Findings)
	slices.Reverse(b.Checks)

	a.Finalize()
	b.Finalize()

	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("different arrival order produced different results:\n%s\n%s", ja, jb)
	}
	// Gates first, then by path: gate a, gate b, then the note.
	var paths []string
	for _, f := range a.Findings {
		paths = append(paths, f.ID+":"+f.Locations[0].Path)
	}
	want := []string{"F-0001:a.js", "F-0002:b.js", "F-0003:z.js"}
	if !slices.Equal(paths, want) {
		t.Fatalf("finding order = %v, want %v", paths, want)
	}
	// Executions sort by Check ID then Context ID.
	if a.Checks[0].ID != "E-0001" || a.Checks[0].ContextID != "C-0002" || a.Checks[1].ContextID != "C-0003" {
		t.Fatalf("executions not ordered by check and context: %+v", a.Checks)
	}
	// Findings point at the new execution IDs, and executions list their Findings.
	for _, f := range a.Findings {
		if f.ExecutionID != "E-0002" {
			t.Fatalf("finding %s points at %s, want E-0002", f.ID, f.ExecutionID)
		}
	}
	if got := a.Checks[1].FindingIDs; !slices.Equal(got, []string{"F-0001", "F-0002", "F-0003"}) {
		t.Fatalf("execution finding IDs = %v", got)
	}
}

func TestFinalizeDerivesOutcomeAndSummary(t *testing.T) {
	s := handMade()
	s.Finalize()

	clean, failing := s.Checks[0], s.Checks[1]
	if clean.Outcome != resultset.OutcomePassed || clean.Gate != 0 {
		t.Errorf("execution without Findings: outcome %q gate %d, want passed and 0", clean.Outcome, clean.Gate)
	}
	if failing.Outcome != resultset.OutcomeFailed || failing.Gate != 2 {
		t.Errorf("execution with two Gates: outcome %q gate %d, want failed and 2", failing.Outcome, failing.Gate)
	}
	if s.Summary.Gates != 2 || s.Summary.FindingsBySeverity.Error != 2 || s.Summary.FindingsBySeverity.Note != 1 {
		t.Errorf("summary = %+v", s.Summary)
	}
	if s.Summary.ScopeCompleteness.Required != 2 || s.Summary.ScopeCompleteness.Completed != 2 {
		t.Errorf("scope completeness = %+v", s.Summary.ScopeCompleteness)
	}
	if s.Run.ExitCode != resultset.ExitGate {
		t.Errorf("run exit code = %d, want 1", s.Run.ExitCode)
	}
	if s.Run.Status != resultset.RunCompleted {
		t.Errorf("run status = %q", s.Run.Status)
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Errorf("finalized set is invalid: %v", problems)
	}
}

func TestFinalizeMarksRunIncompleteWhenASelectedCheckDidNotComplete(t *testing.T) {
	s := handMade()
	s.Findings = nil
	s.Checks[0].Status = resultset.StatusBudgetExhausted
	s.Finalize()

	if s.Run.Status != resultset.RunIncomplete || s.Run.ExitCode != resultset.ExitIncomplete {
		t.Fatalf("run status %q exit %d, want incomplete and 2", s.Run.Status, s.Run.ExitCode)
	}
	if got := s.Checks[1].Outcome; got != resultset.OutcomeUnknown {
		t.Errorf("outcome of a non-completed execution = %q, want unknown", got)
	}
	if s.Summary.ScopeCompleteness.Required != 2 || s.Summary.ScopeCompleteness.Completed != 1 {
		t.Errorf("scope completeness = %+v", s.Summary.ScopeCompleteness)
	}
}

func TestDeselectedCheckLowersStandardButNotScopeCompletenessAndNeverTheExitCode(t *testing.T) {
	s := handMade()
	s.Findings = nil
	// One of the two applicable Checks is left out by --exclude.
	s.Checks[0].Selected = false
	s.Checks[0].Status = resultset.StatusNotStarted
	s.Finalize()

	if got := s.Summary.ScopeCompleteness; got.Required != 1 || got.Completed != 1 || got.Ratio == nil || *got.Ratio != 1 {
		t.Errorf("scope completeness = %+v, want 1 of 1", got)
	}
	if got := s.Summary.StandardCompleteness; got.Required != 2 || got.Completed != 1 || got.Ratio == nil || *got.Ratio != 0.5 {
		t.Errorf("standard completeness = %+v, want 1 of 2", got)
	}
	if s.Run.ExitCode != resultset.ExitOK || s.Run.Status != resultset.RunCompleted {
		t.Errorf("exit %d, run status %q: a deselected Check must not change either", s.Run.ExitCode, s.Run.Status)
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Errorf("a Report with a deselected Check is invalid: %v", problems)
	}
}

func TestValidateRejectsInconsistentSets(t *testing.T) {
	mutations := map[string]func(s *resultset.Set){
		"finding points at an unknown execution": func(s *resultset.Set) { s.Findings[0].ExecutionID = "E-9999" },
		"finding points at an unknown context":   func(s *resultset.Set) { s.Findings[0].ContextID = "C-9999" },
		"duplicate finding ID":                   func(s *resultset.Set) { s.Findings[1].ID = s.Findings[0].ID },
		"passed outcome with Findings":           func(s *resultset.Set) { s.Checks[1].Outcome = resultset.OutcomePassed },
		"gate count does not match Findings":     func(s *resultset.Set) { s.Checks[1].Gate = 7 },
		"summary gate count is wrong":            func(s *resultset.Set) { s.Summary.Gates = 9 },
		"execution lists an unknown finding":     func(s *resultset.Set) { s.Checks[1].FindingIDs = append(s.Checks[1].FindingIDs, "F-4242") },
		"selected applicable Check never started": func(s *resultset.Set) {
			s.Checks[0].Status = resultset.StatusNotStarted
		},
		"benchmark not requested but scored": func(s *resultset.Set) {
			s.Benchmark = resultset.Benchmark{Status: resultset.BenchmarkNotRequested, Score: ptr(50.0)}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s := handMade()
			s.Finalize()
			s.Benchmark = resultset.Benchmark{Status: resultset.BenchmarkNotRequested}
			mutate(s)
			if problems := s.Validate(); len(problems) == 0 {
				t.Fatal("Validate accepted an inconsistent set")
			}
		})
	}
}
