package resultset_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func testCase(file, title string, outcome resultset.TestOutcome) resultset.TestCase {
	return resultset.TestCase{
		ID: "tc-" + title, ExecutionID: "tmp-a", File: file, FullTitle: title, SuitePath: []string{"suite"},
		Outcome: outcome, FindingIDs: []string{},
		Attempts: []resultset.TestAttempt{{Outcome: outcome, DurationMS: 3}},
	}
}

func TestFinalizeMovesPassedTestCasesToAnArtifactReferencedByTheExecution(t *testing.T) {
	s := handMade()
	s.TestCases = []resultset.TestCase{
		testCase("test/b.js", "b works", resultset.TestPassed),
		testCase("test/a.js", "a works", resultset.TestPassed),
		testCase("test/a.js", "a fails", resultset.TestFailed),
		testCase("test/a.js", "a is skipped", resultset.TestSkipped),
	}
	s.Finalize()

	if len(s.TestCases) != 2 {
		t.Fatalf("report.json keeps %d test cases, want the failed and the skipped one", len(s.TestCases))
	}
	for _, tc := range s.TestCases {
		if tc.Outcome == resultset.TestPassed {
			t.Errorf("passed test case %q stayed in the list", tc.FullTitle)
		}
	}
	if s.Summary.TestCases.Passed != 2 || s.Summary.TestCases.Failed != 1 || s.Summary.TestCases.Skipped != 1 {
		t.Errorf("test case counts = %+v", s.Summary.TestCases)
	}
	exec := s.Checks[0] // tmp-a became E-0001
	if len(exec.ArtifactIDs) != 1 {
		t.Fatalf("execution lists artifacts %v, want the passed-tests file", exec.ArtifactIDs)
	}
	a := artifactByID(s, exec.ArtifactIDs[0])
	if a == nil || a.MediaType != "application/json" || !strings.HasPrefix(a.Path, "artifacts/tests/") {
		t.Fatalf("artifact = %+v", a)
	}
	body := string(a.Content)
	if strings.Index(body, "a works") < 0 || strings.Index(body, "a works") > strings.Index(body, "b works") {
		t.Errorf("passed cases are missing or not sorted by file:\n%s", body)
	}
	if strings.Contains(body, "a fails") {
		t.Error("a failed case leaked into the passed-tests artifact")
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Errorf("finalized set is invalid: %v", problems)
	}
	// A second Finalize must neither lose nor double the counts.
	s.Finalize()
	if s.Summary.TestCases.Passed != 2 || len(s.Artifacts) != 1 {
		t.Errorf("second Finalize changed the result: passed %d, artifacts %d", s.Summary.TestCases.Passed, len(s.Artifacts))
	}
}
