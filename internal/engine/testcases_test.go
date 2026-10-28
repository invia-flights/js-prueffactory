package engine

import (
	"context"
	"io"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

// A suite Check hands over test cases that point at its Findings by position.
// The engine gives them the IDs of the execution and of those Findings.

type fakeSuite struct{}

func (fakeSuite) Applicability(*discovery.Project, *discovery.Context) (resultset.Applicability, string) {
	return resultset.Applicable, ""
}

func (fakeSuite) Run(context.Context, *checks.Input) *checks.Result {
	return &checks.Result{
		Status: resultset.StatusCompleted,
		Findings: []resultset.Finding{
			{Title: "hook", Gate: true},
			{Title: "test", Gate: true},
		},
		TestCases: []checks.SuiteTestCase{
			{TestCase: resultset.TestCase{FullTitle: "passes", Outcome: resultset.TestPassed}},
			{TestCase: resultset.TestCase{FullTitle: "fails", Outcome: resultset.TestFailed}, Findings: []int{1}},
			{TestCase: resultset.TestCase{FullTitle: "never ran", Outcome: resultset.TestNeverRun}, Findings: []int{0}},
		},
	}
}

func executeFake(t *testing.T, deselected bool) *execResult {
	t.Helper()
	r := &run{
		log:  progress.New(io.Discard, nil),
		snap: &snapshot.Snapshot{Dir: t.TempDir()},
		proj: &discovery.Project{},
	}
	p := &planned{
		key: "x7", entry: checks.Entry{ID: "tests.existing", Family: "tests"}, check: fakeSuite{},
		context:       &discovery.Context{Context: resultset.Context{ID: "C-0002"}},
		applicability: resultset.Applicable, deselected: deselected, prerequisite: deselected,
	}
	return r.execute(context.Background(), context.Background(), p, false)
}

func TestTestCasesOfAnExecutionKeepTheirOutcomesAndPointAtItsFindings(t *testing.T) {
	res := executeFake(t, false)

	if len(res.testCases) != 3 {
		t.Fatalf("test cases = %+v", res.testCases)
	}
	for _, tc := range res.testCases {
		if tc.ExecutionID != "x7" {
			t.Errorf("%s belongs to execution %q", tc.FullTitle, tc.ExecutionID)
		}
	}
	byTitle := map[string]resultset.TestCase{}
	for _, tc := range res.testCases {
		byTitle[tc.FullTitle] = tc
	}
	if got := byTitle["fails"].FindingIDs; !slices.Equal(got, []string{res.findings[1].ID}) {
		t.Errorf("fails -> %v, findings %q", got, res.findings[1].ID)
	}
	if got := byTitle["never ran"].FindingIDs; !slices.Equal(got, []string{res.findings[0].ID}) {
		t.Errorf("never ran -> %v, findings %q", got, res.findings[0].ID)
	}
	if got := byTitle["passes"].FindingIDs; len(got) != 0 {
		t.Errorf("passes -> %v", got)
	}
}

func TestAPrerequisiteThatWasNotSelectedReportsNoTestCases(t *testing.T) {
	if res := executeFake(t, true); len(res.testCases) != 0 || len(res.findings) != 0 {
		t.Errorf("test cases %+v, findings %+v", res.testCases, res.findings)
	}
}
