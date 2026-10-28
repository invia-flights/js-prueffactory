//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of runtime.unhandled-rejections: a project goes in through the
// entry point, the Report comes out. The testdata project unhandled-rejection
// has two packages with the same test, a floating promise that rejects while the
// test waits, and a listener that only logs: the root package runs Mocha 10, the
// package in mocha11 runs Mocha 11. unhandled-rejection-crash has a rejection
// that happens while its test file loads.

func rejectionFindingsOf(s *resultset.Set, rule string) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range findingsOf(s, "runtime.unhandled-rejections") {
		if ruleIs(f, rule) {
			out = append(out, f)
		}
	}
	return out
}

// contextPath is the package folder of a Context of the Report.
func contextPath(t *testing.T, s *resultset.Set, id string) string {
	t.Helper()
	for _, c := range s.Contexts {
		if c.ID == id {
			return c.Path
		}
	}
	t.Fatalf("no Context %s", id)
	return ""
}

func TestAFloatingPromiseThatPassesNormallyFailsInTheStrictRunOnMocha10And11(t *testing.T) {
	original := copyProject(t, "unhandled-rejection")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "runtime.unhandled-rejections")

	// tests.existing is not selected: the strict failure is a warning and no Gate.
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	execs := executionsOf(&r.set, "runtime.unhandled-rejections")
	if len(execs) != 2 {
		t.Fatalf("executions = %+v, want one per package", execs)
	}
	for _, e := range execs {
		if !e.Selected || e.Status != resultset.StatusCompleted || e.Gate != 0 {
			t.Errorf("execution = %+v", e)
		}
	}
	for _, e := range executionsOf(&r.set, "tests.existing") {
		if e.Selected || e.Status != resultset.StatusCompleted {
			t.Errorf("tests.existing = %+v, want the first run made without it being selected", e)
		}
	}

	fs := rejectionFindingsOf(&r.set, "unhandled-rejection")
	if len(fs) != 2 {
		t.Fatalf("Findings = %d, want one for Mocha 10 and one for Mocha 11: %+v", len(fs), findingsOf(&r.set, "runtime.unhandled-rejections"))
	}
	paths := map[string]bool{}
	for _, f := range fs {
		paths[contextPath(t, &r.set, f.ContextID)] = true
		if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
			t.Errorf("finding = %+v, want a warning, likely, no Gate", f)
		}
		if want := "Test fails with strict unhandled rejections: user passes although its floating promise rejects"; f.Title != want {
			t.Errorf("title = %q, want %q", f.Title, want)
		}
		var evidence []string
		for _, e := range f.Evidence {
			evidence = append(evidence, e.Text)
			if e.Trust != resultset.TrustUntrusted {
				t.Errorf("evidence %+v is project text and must be untrusted", e)
			}
		}
		if text := strings.Join(evidence, "\n"); !strings.Contains(text, "user service is down") {
			t.Errorf("evidence = %q, want the error of the strict run", text)
		}
		tr := f.Reproduction.Test
		if tr == nil || !strings.HasPrefix(strings.Join(tr.NativeCommand, " "), "env NODE_OPTIONS=--unhandled-rejections=strict npx mocha ") {
			t.Errorf("reproduction = %+v", tr)
		}
	}
	if !paths["."] || !paths["mocha11"] {
		t.Errorf("Findings are in the packages %v, want the root (Mocha 10) and mocha11", paths)
	}

	// tests.flaky is not selected, so the differences may be flakiness.
	limits := 0
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "flakiness_not_excluded" && l.CheckID != nil && *l.CheckID == "runtime.unhandled-rejections" {
			limits++
		}
	}
	if limits != 2 {
		t.Errorf("flakiness_not_excluded Limitations = %d, want one per package: %+v", limits, r.set.Limitations)
	}
	// The first run is the reference for the Inventory and is unchanged.
	for _, p := range r.set.Inventory.Tests {
		if p.Found != 2 || p.Passed != 2 || p.Failed != 0 {
			t.Errorf("inventory = %+v, want the two passing tests of the first run", p)
		}
	}
	if got := treeFingerprint(t, original); got != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestWithTestsFlakyTheStrictRunIsTheFourthRunAndNoLimitationRemains(t *testing.T) {
	original := copyProject(t, "unhandled-rejection")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.flaky,runtime.unhandled-rejections")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if got := len(rejectionFindingsOf(&r.set, "unhandled-rejection")); got != 2 {
		t.Errorf("Findings = %d, want 2: the test does not differ between the runs without the flag", got)
	}
	if fs := findingsOf(&r.set, "tests.flaky"); len(fs) != 0 {
		t.Errorf("tests.flaky Findings = %+v, want none", fs)
	}
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "flakiness_not_excluded" {
			t.Errorf("tests.flaky ran, so flakiness is excluded: %+v", l)
		}
	}
	for _, m := range r.set.Metrics {
		if m.CheckID == "runtime.unhandled-rejections" && m.Name == "explained_by_flakiness" && (m.Value == nil || *m.Value != 0) {
			t.Errorf("explained_by_flakiness = %v, want 0", m.Value)
		}
	}
	logs := map[string]int{}
	for _, a := range r.set.Artifacts {
		if strings.Contains(a.Path, "test-output-run") {
			logs[a.CheckID+"/"+a.Path[strings.LastIndex(a.Path, "/")+1:]]++
		}
	}
	for _, want := range []string{"tests.flaky/test-output-run2.log", "tests.flaky/test-output-run3.log", "runtime.unhandled-rejections/test-output-run4.log"} {
		if logs[want] != 2 {
			t.Errorf("command logs = %v, want %s once per package", logs, want)
		}
	}
	r.assertNothingLeft(t)
}

func TestAnErrorWhileATestFileLoadsIsOneFindingForTheSuiteAndNotOnePerTest(t *testing.T) {
	original := copyProject(t, "unhandled-rejection-crash")

	r := realRun(t, context.Background(), "test", original, "--only", "runtime.unhandled-rejections")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: the normal run passes\nstderr:\n%s", r.code, r.stderr)
	}
	all := findingsOf(&r.set, "runtime.unhandled-rejections")
	if len(all) != 1 || !ruleIs(all[0], "unhandled-rejection-crash") {
		t.Fatalf("Findings = %+v, want the one crash Finding and nothing for the tests that never ran", all)
	}
	f := all[0]
	if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
		t.Errorf("finding = %+v", f)
	}
	var evidence []string
	for _, e := range f.Evidence {
		evidence = append(evidence, e.Text)
	}
	if text := strings.Join(evidence, "\n"); !strings.Contains(text, "the setup call failed while the file loads") {
		t.Errorf("evidence = %q, want the uncaught error", text)
	}
	if l := f.Locations[0]; l.Path != "test/load.test.js" || l.Start == nil || l.Start.Line != 12 {
		t.Errorf("location = %+v, want the line of the rejected promise", l)
	}
	r.assertNothingLeft(t)
}

func TestACleanProjectHasNoUnhandledRejection(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.flaky,runtime.unhandled-rejections")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "runtime.unhandled-rejections"); e.Status != resultset.StatusCompleted {
		t.Errorf("runtime.unhandled-rejections = %+v", e)
	}
	if fs := findingsOf(&r.set, "runtime.unhandled-rejections"); len(fs) != 0 {
		t.Errorf("findings = %+v, want none", fs)
	}
	r.assertNothingLeft(t)
}

func TestTheBenchmarkCountsTheStrictRunFindingsInTheCodeCorrectnessArea(t *testing.T) {
	original := copyProject(t, "unhandled-rejection")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "package.install,tests.existing,tests.flaky,runtime.unhandled-rejections")

	part := benchmarkPart(t, &r.set, "unhandled_rejections")
	if part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue != 2 || part.Score == nil || *part.Score != 50 {
		t.Errorf("unhandled rejections part = %+v, want two Findings and 100 * 2^(-2/2) = 50", part)
	}
	r.assertNothingLeft(t)
}
