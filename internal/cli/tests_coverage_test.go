package cli_test

import (
	"strings"
	"testing"
)

// Seam A without Docker: what list-checks says about tests.coverage. It
// measures the run of tests.existing, so it applies where that run applies and
// is unsupported where that run is.

func testsCoverageRow(t *testing.T, files map[string]string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, projectWith(t, files), "--format", "json")
	row := l.Checks[rowOf(t, l, "tests.coverage")]
	if len(row.Applicability) != 1 {
		t.Fatalf("tests.coverage applicability = %+v", row.Applicability)
	}
	return row.Applicability[0].Applicability, row.Applicability[0].Reason
}

func TestTestsCoverageIsImplementedSelectedAndNeverFiresGates(t *testing.T) {
	l := listChecksJSON(t, projectWith(t, map[string]string{"package.json": `{"name":"demo"}`}), "--format", "json")
	row := l.Checks[rowOf(t, l, "tests.coverage")]
	if row.Status != "implemented" || !row.Selected || row.CanFireGates || row.BenchmarkArea != "side_indicator" {
		t.Errorf("tests.coverage = %+v", row)
	}
}

func TestTestsCoverageAppliesToAPackageWithTestsThatCanRun(t *testing.T) {
	got, reason := testsCoverageRow(t, map[string]string{
		"package.json": `{"name":"demo","scripts":{"test":"c8 mocha"}}`, "package-lock.json": `{"lockfileVersion":3,"packages":{}}`,
	})
	if got != "unknown" || !strings.Contains(reason, "Mocha version") {
		t.Errorf("tests.coverage = %s %q, want unknown (the Mocha version is known only after the install)", got, reason)
	}
}

func TestTestsCoverageIsUnsupportedWhereTheRunnerIsAndNotApplicableWithoutTests(t *testing.T) {
	got, reason := testsCoverageRow(t, map[string]string{
		"package.json": `{"scripts":{"test":"jest --ci"}}`, "package-lock.json": `{"lockfileVersion":3,"packages":{}}`,
	})
	if got != "applicable" || !strings.HasPrefix(reason, "unsupported: ") || !strings.Contains(reason, "Jest") {
		t.Errorf("jest: tests.coverage = %s %q", got, reason)
	}
	got, reason = testsCoverageRow(t, map[string]string{"package.json": `{"name":"demo","scripts":{"start":"node ."}}`})
	if got != "not_applicable" || !strings.Contains(reason, "no test script") {
		t.Errorf("no script: tests.coverage = %s %q", got, reason)
	}
}
