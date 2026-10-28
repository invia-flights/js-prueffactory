//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of tests.flaky: a project goes in through the entry point, the
// Report comes out. The testdata project flaky-test has a test that fails only
// in the second run of the suite, because it counts the runs in a file of its
// package folder, a test that fails in every run and a test that always passes.

func flakyFindingsOf(s *resultset.Set) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range findingsOf(s, "tests.flaky") {
		if ruleIs(f, "flaky-test") {
			out = append(out, f)
		}
	}
	return out
}

func TestATestThatFailsOnlyInTheSecondRunIsReportedWithAllThreeOutcomes(t *testing.T) {
	original := copyProject(t, "flaky-test")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "tests.flaky")

	// tests.existing is not selected, so the failing test is no Gate here.
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.flaky")
	if !e.Selected || e.Status != resultset.StatusCompleted || e.Gate != 0 {
		t.Errorf("tests.flaky = %+v", e)
	}
	if tests := oneExecution(t, &r.set, "tests.existing"); tests.Selected || tests.Status != resultset.StatusCompleted {
		t.Errorf("tests.existing = %+v, want the first run made without it being selected", tests)
	}

	fs := flakyFindingsOf(&r.set)
	if len(fs) != 1 {
		t.Fatalf("Flaky test Findings = %d, want 1: %+v", len(fs), findingsOf(&r.set, "tests.flaky"))
	}
	f := fs[0]
	if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceConfirmed || f.Gate {
		t.Errorf("finding = %+v, want a warning, confirmed, no Gate", f)
	}
	if want := "Flaky test: counter fails only in the second run (runs: passed, failed, passed)"; f.Title != want {
		t.Errorf("title = %q, want %q", f.Title, want)
	}
	if len(f.Evidence) != 3 {
		t.Fatalf("evidence = %+v, want one item per run", f.Evidence)
	}
	for i, want := range []string{"run 1 (first run): passed", "run 2: failed", "run 3: passed"} {
		if !strings.HasPrefix(f.Evidence[i].Text, want) {
			t.Errorf("evidence %d = %q, want it to start with %q", i, f.Evidence[i].Text, want)
		}
	}
	if !strings.Contains(f.Evidence[1].Text, "this is run 2") {
		t.Errorf("the failed run lists its error: %q", f.Evidence[1].Text)
	}
	if tr := f.Reproduction.Test; tr == nil || tr.File != "test/counter.test.js" || tr.FullTitle != "counter fails only in the second run" ||
		strings.Join(tr.NativeCommand, " ") != "npx mocha --fgrep counter fails only in the second run test/counter.test.js" {
		t.Errorf("reproduction = %+v", f.Reproduction.Test)
	}
	if l := f.Locations[0]; l.Path != "test/counter.test.js" || l.Start == nil {
		t.Errorf("location = %+v, want the line of the failed assertion", l)
	}

	var count *float64
	for _, m := range r.set.Metrics {
		if m.CheckID == "tests.flaky" && m.Name == "flaky_tests" {
			count = m.Value
		}
	}
	if count == nil || *count != 1 {
		t.Errorf("flaky_tests = %v, want 1", count)
	}
	if got := treeFingerprint(t, original); got != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestATestThatFailsInEveryRunIsAFailedTestAndNotAFlakyTest(t *testing.T) {
	original := copyProject(t, "flaky-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.flaky")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1: the test that always fails is a Gate\nstderr:\n%s", r.code, r.stderr)
	}
	gates := 0
	for _, f := range findingsOf(&r.set, "tests.existing") {
		if f.Gate {
			gates++
			if !strings.Contains(f.Title, "counter fails in every run") {
				t.Errorf("Gate = %q, want the test that fails in every run", f.Title)
			}
		}
	}
	if gates != 1 {
		t.Errorf("tests.existing Gates = %d, want 1: the first run is the only one it reports", gates)
	}
	for _, f := range flakyFindingsOf(&r.set) {
		if strings.Contains(f.Title, "fails in every run") || strings.Contains(f.Title, "passes in every run") {
			t.Errorf("not flaky: %+v", f)
		}
	}
	// The first run is the reference: the test that fails only in the second
	// run passed there, so the pass rate sees two of three tests.
	if got := r.set.Inventory.Tests; len(got) != 1 || got[0].Found != 3 || got[0].Passed != 2 || got[0].Failed != 1 {
		t.Errorf("inventory = %+v, want the counts of the first run only", got)
	}
	// Repeat runs are not measured: tests.coverage and runtime.warnings are not
	// selected here, and the suite's logs of the repeat runs belong to tests.flaky.
	e := oneExecution(t, &r.set, "tests.flaky")
	found := 0
	for _, a := range r.set.Artifacts {
		if a.CheckID == "tests.flaky" && strings.Contains(a.Path, "test-output-run") {
			found++
		}
	}
	if found != 2 {
		t.Errorf("tests.flaky has %d repeat-run logs among %v, want 2", found, e.ArtifactIDs)
	}
	r.assertNothingLeft(t)
}

func TestRepeatRunsDoNotChangeCoverageOrTheWarningsOfTheFirstRun(t *testing.T) {
	original := copyProject(t, "flaky-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage,runtime.warnings,tests.flaky")

	for _, check := range []string{"tests.coverage", "runtime.warnings", "tests.flaky"} {
		if e := oneExecution(t, &r.set, check); e.Status != resultset.StatusCompleted {
			t.Errorf("%s = %+v", check, e)
		}
	}
	if got := len(flakyFindingsOf(&r.set)); got != 1 {
		t.Errorf("Flaky tests = %d, want 1", got)
	}
	r.assertNothingLeft(t)
}

func TestTheBenchmarkScoresFlakyTestsAsAPartOfTheTestsAreaAndKeepsThePassRateOnTheFirstRun(t *testing.T) {
	original := copyProject(t, "flaky-test")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "package.install,tests.existing,tests.smells,tests.flaky")

	flaky := benchmarkPart(t, &r.set, "flaky_tests")
	if flaky.State != resultset.PartMeasured || flaky.RawValue == nil || *flaky.RawValue != 1 || flaky.Score == nil || *flaky.Score != 79.4 {
		t.Errorf("flaky tests part = %+v, want one Flaky test and 100 * 2^(-1/3) = 79.4", flaky)
	}
	pass := benchmarkPart(t, &r.set, "pass_rate")
	if pass.State != resultset.PartMeasured || pass.Score == nil || *pass.Score < 66.6 || *pass.Score > 66.7 {
		t.Errorf("pass rate = %+v, want 2 of 3 tests of the first run", pass)
	}
	if tests := benchmarkArea(t, &r.set, "tests"); tests.Score != nil && *tests.Score >= 100 {
		t.Errorf("Tests area = %+v", tests)
	}
	r.assertNothingLeft(t)
}

func TestACleanProjectHasNoFlakyTest(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.flaky")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "tests.flaky"); e.Status != resultset.StatusCompleted {
		t.Errorf("tests.flaky = %+v", e)
	}
	if fs := findingsOf(&r.set, "tests.flaky"); len(fs) != 0 {
		t.Errorf("findings = %+v, want none", fs)
	}
	r.assertNothingLeft(t)
}

func TestEveryRepeatRunGetsFreshServices(t *testing.T) {
	// The tests of valkey-service need an empty Valkey. If a repeat run reused
	// the Service of the run before, "starts empty" would fail there and show as
	// a Flaky test.
	original := copyProject(t, "valkey-service")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.flaky")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	for _, e := range executionsOf(&r.set, "tests.flaky") {
		if e.Applicability != resultset.NotApplicable && e.Status != resultset.StatusCompleted {
			t.Errorf("tests.flaky = %+v", e)
		}
	}
	if fs := findingsOf(&r.set, "tests.flaky"); len(fs) != 0 {
		t.Errorf("findings = %+v, want none: every run had an empty Valkey", fs)
	}
	r.assertNothingLeft(t)
}
