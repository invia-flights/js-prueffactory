package checks

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// tests.coverage of a package with several suites: every suite writes raw
// coverage into one run-owned location, and one report over it is the Coverage
// of the package.

// stubCoverageStore replaces the Docker work of the shared coverage location: it
// counts the volumes that were made and the reports that were built.
func stubCoverageStore(t *testing.T, summary string) (volumes, reports *int) {
	t.Helper()
	var v, r int
	oldCreate, oldReport := createCoverageVolume, buildCoverageReport
	t.Cleanup(func() { createCoverageVolume, buildCoverageReport = oldCreate, oldReport })
	createCoverageVolume = func(context.Context, *Input) (string, error) {
		v++
		return "coverage-volume", nil
	}
	buildCoverageReport = func(_ context.Context, in *Input) (sum, perFile []byte) {
		r++
		if in.coverageVolume != "coverage-volume" {
			t.Errorf("the report is built from volume %q", in.coverageVolume)
		}
		return []byte(summary), []byte(finalTwoFiles)
	}
	return &v, &r
}

func TestCoverageOfSeveralSuitesIsOneReportOverTheRawCoverageOfAllOfThem(t *testing.T) {
	in := twoSuiteInput(t)
	seen := map[string]string{}
	stubSuites(t, func(in *Input, _ int) *Result {
		seen[in.suite().Origin] = in.coverageVolume
		return &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{}}
	})
	volumes, reports := stubCoverageStore(t, summaryTwoFiles)

	res := Implementation(testsCoverageID).Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || res.ReasonCode != "" {
		t.Fatalf("result = %s / %s / %s", res.Status, res.ReasonCode, res.Reason)
	}
	if *volumes != 1 || *reports != 1 {
		t.Errorf("%d volumes and %d reports, want one location and one report for the package", *volumes, *reports)
	}
	if seen["test:unit"] != "coverage-volume" || seen["test:api"] != "coverage-volume" {
		t.Errorf("the suites wrote to %v, want the one shared location", seen)
	}
	if m := metricsByName(res.Metrics)["lines"]; m.Value == nil || *m.Value < 61.5 || *m.Value > 61.6 || m.Reason != nil {
		t.Errorf("lines = %+v", m)
	}
}

func TestTheSuitesAreRunAndMeasuredOnceWhicheverCheckAsksFirst(t *testing.T) {
	in := twoSuiteInput(t)
	stubSuites(t, func(*Input, int) *Result {
		return &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{}}
	})
	volumes, reports := stubCoverageStore(t, summaryTwoFiles)

	testsExisting{}.Run(context.Background(), in)
	Implementation(testsCoverageID).Run(context.Background(), in)

	if *volumes != 1 || *reports != 1 {
		t.Errorf("%d volumes and %d reports, want one each", *volumes, *reports)
	}
}

func TestWithoutTestsCoverageSelectedNoLocationAndNoReportAreMade(t *testing.T) {
	in := twoSuiteInput(t)
	in.Selection = selectionWithout(t, testsCoverageID)
	stubSuites(t, func(*Input, int) *Result { return &Result{Status: resultset.StatusCompleted} })
	volumes, reports := stubCoverageStore(t, summaryTwoFiles)

	testsExisting{}.Run(context.Background(), in)

	if *volumes != 0 || *reports != 0 {
		t.Errorf("%d volumes and %d reports, want none", *volumes, *reports)
	}
}

func TestACoverageLocationThatCannotBeMadeIsTheReasonOfTheCheck(t *testing.T) {
	in := twoSuiteInput(t)
	stubSuites(t, func(in *Input, _ int) *Result {
		return &Result{Status: resultset.StatusCompleted, coverage: in.addCoverage(&docker.ContainerSpec{})}
	})
	oldCreate := createCoverageVolume
	t.Cleanup(func() { createCoverageVolume = oldCreate })
	createCoverageVolume = func(context.Context, *Input) (string, error) { return "", errors.New("boom") }
	in.ToolsetVolume = "toolset"

	res := Implementation(testsCoverageID).Run(context.Background(), in)

	if res.Status != resultset.StatusInfrastructureError || res.ReasonCode != "coverage_location_unavailable" || !strings.Contains(res.Reason, "boom") || len(res.Metrics) != 0 {
		t.Errorf("result = %+v", res)
	}
}

func TestASuiteThatDidNotRunIsNamedInTheNoteOfTheCoverage(t *testing.T) {
	in := twoSuiteInput(t)
	stubSuites(t, func(_ *Input, ran int) *Result {
		if ran == 1 {
			return &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready", Reason: "Service db did not come up"}
		}
		return &Result{Status: resultset.StatusCompleted, coverage: &coverageRun{}}
	})
	stubCoverageStore(t, summaryTwoFiles)

	res := Implementation(testsCoverageID).Run(context.Background(), in)

	if len(res.Metrics) != 3 {
		t.Fatalf("metrics = %+v", res.Metrics)
	}
	for _, m := range res.Metrics {
		if m.Value == nil || m.Reason == nil || !strings.Contains(*m.Reason, "test:api did not run its tests") {
			t.Errorf("%s = %+v, want the value and a note that names the suite", m.Name, m)
		}
	}
}

func TestWhenNoSuiteReachedItsTestsThereIsNoReportToBuild(t *testing.T) {
	in := twoSuiteInput(t)
	stubSuites(t, func(*Input, int) *Result {
		return &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "service_not_ready", Reason: "Service db did not come up"}
	})
	_, reports := stubCoverageStore(t, summaryTwoFiles)

	res := Implementation(testsCoverageID).Run(context.Background(), in)

	if *reports != 0 {
		t.Errorf("%d reports built", *reports)
	}
	allNullWithReason(t, res.Metrics, "did not run")
}
