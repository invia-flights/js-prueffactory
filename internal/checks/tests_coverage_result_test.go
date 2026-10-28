package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// How tests.coverage ends from what the suite's one run left behind. A number
// is only ever reported when c8 wrote one.

func coverageInput() *Input {
	pkg := &discovery.Package{Path: "."}
	return &Input{Project: &discovery.Project{Packages: []*discovery.Package{pkg}},
		Context: &discovery.Context{Context: resultset.Context{ID: "C-0002"}, Package: pkg}}
}

func allNullWithReason(t *testing.T, ms []resultset.Metric, contains string) {
	t.Helper()
	if len(ms) != 3 {
		t.Fatalf("metrics = %+v, want lines, branches and functions", ms)
	}
	for _, m := range ms {
		if m.Value != nil || m.Reason == nil || !strings.Contains(*m.Reason, contains) {
			t.Errorf("%s = %+v, want null with a reason holding %q", m.Name, m, contains)
		}
	}
}

func TestCoverageOfAnUnsupportedSuiteIsUnsupportedWithTheSameReason(t *testing.T) {
	suite := &Result{Status: resultset.StatusUnsupported, ReasonCode: "test_runner_not_implemented", Reason: "Jest is not supported"}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusUnsupported || got.ReasonCode != "test_runner_not_implemented" || got.Reason != "Jest is not supported" || len(got.Metrics) != 0 {
		t.Errorf("result = %+v", got)
	}
}

func TestCoverageWithoutTheToolsetIsAnInfrastructureErrorAndHasNoNumbers(t *testing.T) {
	suite := &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{Unavailable: "the toolset volume with c8 could not be prepared: boom"}}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusInfrastructureError || got.ReasonCode != "toolset_unavailable" || !strings.Contains(got.Reason, "boom") || len(got.Metrics) != 0 {
		t.Errorf("result = %+v", got)
	}
}

func TestCoverageOfASuiteThatNeverStartedHasNullMetricsAndTheStatusOfTheSuite(t *testing.T) {
	notInstalled := &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{{Gate: true, Title: "test runner not installed"}}}
	got := coverageInput().coverageResult(notInstalled)
	if got.Status != resultset.StatusCompleted || got.ReasonCode != "" {
		t.Errorf("result = %+v", got)
	}
	allNullWithReason(t, got.Metrics, "test runner not installed")

	noServices := &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready", Reason: "Service db did not come up"}
	got = coverageInput().coverageResult(noServices)
	if got.Status != resultset.StatusInfrastructureError || got.ReasonCode != "service_not_ready" {
		t.Errorf("result = %+v", got)
	}
	allNullWithReason(t, got.Metrics, "Service db did not come up")
}

func TestCoverageOfARunThatTimedOutIsTimedOutWithNullMetrics(t *testing.T) {
	suite := &Result{Status: resultset.StatusTimedOut, ReasonCode: "timeout", Reason: "the Check ran into its time limit", coverage: &coverageRun{}}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusTimedOut || got.ReasonCode != "timeout" {
		t.Errorf("result = %+v", got)
	}
	allNullWithReason(t, got.Metrics, "did not finish")
}

func TestCoverageThatC8DidNotWriteAfterAFinishedRunIsAToolErrorWithNullMetrics(t *testing.T) {
	suite := &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{}}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusToolError || got.ReasonCode != "no_coverage_output" {
		t.Errorf("result = %+v", got)
	}
	allNullWithReason(t, got.Metrics, "no coverage report")
}

func TestCoverageOutputThatCannotBeReadIsAToolErrorWithNullMetrics(t *testing.T) {
	suite := &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{Summary: []byte("{")}}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusToolError || got.ReasonCode != "coverage_output_unreadable" {
		t.Errorf("result = %+v", got)
	}
	allNullWithReason(t, got.Metrics, "not readable")
}

func TestCoverageOfASuiteThatStoppedEarlyIsMeasuredAndSaysSo(t *testing.T) {
	suite := &Result{
		Status: resultset.StatusPartial, ReasonCode: "out_of_memory", Reason: "the test process ran out of memory",
		coverage: &coverageRun{Summary: []byte(summaryTwoFiles)},
	}

	got := coverageInput().coverageResult(suite)

	if got.Status != resultset.StatusCompleted || len(got.Metrics) != 3 || len(got.Artifacts) != 1 {
		t.Fatalf("result = %+v", got)
	}
	for _, m := range got.Metrics {
		if m.Value == nil || m.Reason == nil || !strings.Contains(*m.Reason, "did not finish") {
			t.Errorf("%s = %+v, want the value and a note", m.Name, m)
		}
	}
}

func TestTheNoteOfAFailingSuiteCountsFailedTestsAndMentionsOtherFailures(t *testing.T) {
	gate := resultset.Finding{Gate: true}
	cases := []struct {
		name  string
		suite *Result
		want  string
	}{
		{"nothing wrong", &Result{Status: resultset.StatusCompleted}, ""},
		{"one test", &Result{Status: resultset.StatusCompleted, Inventory: &resultset.Inventory{Tests: []resultset.PackageTests{{Failed: 1}}}, Findings: []resultset.Finding{gate}}, "1 test failed"},
		{"three tests", &Result{Status: resultset.StatusCompleted, Inventory: &resultset.Inventory{Tests: []resultset.PackageTests{{Failed: 3}}}}, "3 tests failed"},
		{"a hook or a file that does not load", &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{gate}}, "failed hook"},
	}
	for _, c := range cases {
		if got := suiteNote(c.suite); (c.want == "" && got != "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: note = %q, want it to hold %q", c.name, got, c.want)
		}
	}
}
