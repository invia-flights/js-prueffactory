package resultset_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A finalized set with a truncated evidence item, a passed-tests artifact, a
// failed test case and a never-run one is valid, and every mutation below
// breaks exactly one rule the spec lists.
func fullSet() *resultset.Set {
	s := handMade()
	s.Findings[0].Evidence = []resultset.Evidence{evidence("tool_output", strings.Repeat("x", 6000))}
	s.TestCases = []resultset.TestCase{
		testCase("test/a.js", "a passes", resultset.TestPassed),
		testCase("test/a.js", "a fails", resultset.TestFailed),
		func() resultset.TestCase {
			tc := testCase("test/b.js", "b never ran", resultset.TestNeverRun)
			tc.NeverRunReason = ptr("root hook failed")
			tc.Attempts = []resultset.TestAttempt{}
			return tc
		}(),
	}
	s.Benchmark = resultset.Benchmark{Status: resultset.BenchmarkNotRequested}
	s.Finalize()
	return s
}

func TestValidateAcceptsAFullFinalizedSet(t *testing.T) {
	if problems := fullSet().Validate(); len(problems) != 0 {
		t.Fatalf("a finalized set must be valid: %v", problems)
	}
}

func TestValidateRejectsEveryBrokenRule(t *testing.T) {
	longText := strings.Repeat("y", resultset.MaxEvidenceBytes+1)
	mutations := map[string]func(s *resultset.Set){
		"evidence text over the cap": func(s *resultset.Set) {
			s.Findings[0].Evidence = []resultset.Evidence{evidence("tool_output", longText)}
		},
		"cut evidence names no artifact": func(s *resultset.Set) {
			for i := range s.Findings {
				for k := range s.Findings[i].Evidence {
					s.Findings[i].Evidence[k].ArtifactID = nil
				}
			}
		},
		"cut evidence claims a smaller original": func(s *resultset.Set) {
			for i := range s.Findings {
				for k := range s.Findings[i].Evidence {
					n := 10
					s.Findings[i].Evidence[k].OriginalSize = &n
				}
			}
		},
		"stack trace with more than 30 frames": func(s *resultset.Set) {
			s.Findings[0].Evidence = []resultset.Evidence{evidence("stack_trace", stackTrace(31))}
		},
		"truncated evidence count is wrong": func(s *resultset.Set) { s.ReportCompleteness.TruncatedEvidence = 5 },
		"artifact content does not match its hash": func(s *resultset.Set) {
			s.Artifacts[0].Content = []byte("changed")
		},
		"artifact path leaves the report folder": func(s *resultset.Set) { s.Artifacts[0].Path = "../escape.txt" },
		"artifact path is absolute":              func(s *resultset.Set) { s.Artifacts[0].Path = "/etc/passwd" },
		"two artifacts share a path":             func(s *resultset.Set) { s.Artifacts[1].Path = s.Artifacts[0].Path },
		"passed test case in the list": func(s *resultset.Set) {
			s.TestCases[0].Outcome = resultset.TestPassed
		},
		"never-run test case without a reason": func(s *resultset.Set) {
			for i := range s.TestCases {
				if s.TestCases[i].Outcome == resultset.TestNeverRun {
					s.TestCases[i].NeverRunReason = nil
				}
			}
		},
		"finding in a different context than its execution": func(s *resultset.Set) { s.Findings[0].ContextID = "C-0001" },
		"finding of a different Check than its execution":   func(s *resultset.Set) { s.Findings[0].CheckID = "tests.existing" },
		"scope completeness does not match the executions": func(s *resultset.Set) {
			s.Summary.ScopeCompleteness.Completed = 0
		},
		"run completed although a selected Check did not complete": func(s *resultset.Set) {
			s.Checks[0].Status = resultset.StatusBudgetExhausted
			s.Checks[0].Outcome = resultset.OutcomeUnknown
		},
		"finding ID is not in sequence": func(s *resultset.Set) {
			old := s.Findings[0].ID
			s.Findings[0].ID = "F-0042"
			for i := range s.Checks {
				for k := range s.Checks[i].FindingIDs {
					if s.Checks[i].FindingIDs[k] == old {
						s.Checks[i].FindingIDs[k] = "F-0042"
					}
				}
			}
		},
		"ID with the wrong prefix": func(s *resultset.Set) { s.TestCases[0].ID = "X-0001" },
		"deselected by --fast although the Run was not fast": func(s *resultset.Set) {
			code := resultset.ReasonDeselectedByFast
			s.Checks[0].Selected, s.Checks[0].ReasonCode = false, &code
		},
		"Check both selected and deselected": func(s *resultset.Set) {
			s.Selection.DeselectedChecks = append(s.Selection.DeselectedChecks, s.Selection.EffectiveChecks...)
		},
		"Finding refers to a Limitation the Report lacks": func(s *resultset.Set) {
			s.Findings[0].Limitations = append(s.Findings[0].Limitations, "service_not_started")
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s := fullSet()
			s.Selection.EffectiveChecks = []string{"syntax.parse"}
			if problems := s.Validate(); len(problems) != 0 {
				t.Fatalf("fixture invalid before the mutation: %v", problems)
			}
			mutate(s)
			if problems := s.Validate(); len(problems) == 0 {
				t.Fatal("Validate accepted a set that breaks the rule")
			}
		})
	}
}
