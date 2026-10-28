//go:build docker

package cli_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests are seam A for the benchmark command: whole Runs on testdata
// projects, looking at the score, the Verdict and the exit code.

func benchmarkPart(t *testing.T, s *resultset.Set, id string) resultset.BenchmarkPart {
	t.Helper()
	for _, a := range s.Benchmark.Areas {
		for _, p := range a.Parts {
			if p.ID == id {
				return p
			}
		}
	}
	t.Fatalf("no part %q in the benchmark section", id)
	return resultset.BenchmarkPart{}
}

func benchmarkArea(t *testing.T, s *resultset.Set, id string) resultset.BenchmarkArea {
	t.Helper()
	for _, a := range s.Benchmark.Areas {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no area %q in the benchmark section", id)
	return resultset.BenchmarkArea{}
}

// executionKeys describes every Check execution of a Run by what the Check
// did, without anything that depends on the clock or the run ID.
func executionKeys(s *resultset.Set) []string {
	var keys []string
	for _, e := range s.Checks {
		reason := ""
		if e.ReasonCode != nil {
			reason = *e.ReasonCode
		}
		keys = append(keys, fmt.Sprintf("%s|%s|selected=%v|%s|%s|%s|%s|gates=%d|findings=%d",
			e.CheckID, e.ContextID, e.Selected, e.Applicability, e.Status, e.Outcome, reason, e.Gate, len(e.FindingIDs)))
	}
	sort.Strings(keys)
	return keys
}

func TestBenchmarkOnACleanProjectGivesASingleScoreAndVerdictPass(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "benchmark", original)

	// An advisory is no Gate, so a clean project exits 0 whatever the
	// advisory database says today.
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if r.set.Run.Command != "benchmark" || r.set.Run.ExitCode != 0 {
		t.Errorf("run = %+v", r.set.Run)
	}
	b := r.set.Benchmark
	if b.Status != resultset.BenchmarkComputed || b.ProfileID == nil || *b.ProfileID != "benchmark-v1-uncalibrated" {
		t.Fatalf("benchmark = %+v", b)
	}
	if b.Score == nil || *b.Score < 0 || *b.Score > 100 {
		t.Fatalf("score = %v, want a single score between 0 and 100", b.Score)
	}
	if b.Verdict == nil || *b.Verdict != resultset.VerdictPass || len(b.GateFindingIDs) != 0 {
		t.Errorf("verdict = %v, gates = %v, want pass", b.Verdict, b.GateFindingIDs)
	}
	if b.Range == nil || b.Range.Low > *b.Score || b.Range.High < *b.Score {
		t.Errorf("range = %+v does not hold the score %v", b.Range, *b.Score)
	}

	// Every part of the four areas the project has is measured.
	for _, a := range b.Areas {
		if a.Exists && !a.FullyMeasured {
			t.Errorf("area %s is not fully measured: %+v", a.ID, a.Parts)
		}
	}
	if p := benchmarkPart(t, &r.set, "pass_rate"); p.State != resultset.PartMeasured || p.Score == nil || *p.Score != 100 {
		t.Errorf("pass rate = %+v, want 100 from the passing suite", p)
	}
	if p := benchmarkPart(t, &r.set, "secrets"); p.Score == nil || *p.Score != 100 {
		t.Errorf("secrets = %+v", p)
	}
	if p := benchmarkPart(t, &r.set, "helm"); p.State != resultset.PartNotApplicable {
		t.Errorf("helm = %+v, want dropped: the project has no chart", p)
	}

	// The fingerprint names the environment the score belongs to.
	f := b.Fingerprint
	if f == nil || len(f.Hash) != 12 || len(f.Fields.Runtimes) != 1 || len(f.Fields.ESLintConfigHashes) == 0 ||
		len(f.Fields.ImageDigests) == 0 || f.Fields.AdvisoryDatabaseDate == nil || f.Fields.ToolsetVersion == "" {
		t.Errorf("fingerprint = %+v", f)
	}
	if len(b.SideIndicators) == 0 {
		t.Error("no side indicators")
	}

	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	for _, want := range []string{"**Score: ", " of 100**", "Verdict: **pass**", "benchmark-v1-uncalibrated",
		"comparable only between Runs with equal fingerprints", f.Hash} {
		if !strings.Contains(md, want) {
			t.Errorf("report.md lacks %q", want)
		}
	}

	if !r.set.Source.OriginalUnchanged || treeFingerprint(t, original) != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestBenchmarkOnAJestProjectHasNoScoreButARangeAndVerdictIncomplete(t *testing.T) {
	original := copyProject(t, "jest-unsupported")

	r := realRun(t, context.Background(), "benchmark", original)

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2, the same as test\nstderr:\n%s", r.code, r.stderr)
	}
	b := r.set.Benchmark
	if b.Status != resultset.BenchmarkIncomplete || b.Score != nil {
		t.Fatalf("benchmark = %+v, want incomplete without a score", b)
	}
	if b.Range == nil || b.Range.Low >= b.Range.High {
		t.Errorf("range = %+v, want a range with a gap", b.Range)
	}
	if b.Verdict == nil || *b.Verdict != resultset.VerdictIncomplete {
		t.Errorf("verdict = %v, want incomplete", b.Verdict)
	}
	p := benchmarkPart(t, &r.set, "pass_rate")
	if p.State != resultset.PartUnknown || p.Reason == nil || !strings.Contains(*p.Reason, "unsupported") || p.Score != nil {
		t.Errorf("pass rate = %+v, want unknown because the runner is unsupported", p)
	}
	if a := benchmarkArea(t, &r.set, "tests"); a.FullyMeasured || a.Score != nil {
		t.Errorf("tests area = %+v", a)
	}
	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	if !strings.Contains(md, "**Score: none**") || !strings.Contains(md, "Range: ") {
		t.Error("report.md does not say there is no single score and show the range")
	}
	r.assertNothingLeft(t)
}

func TestBenchmarkOnABrokenLockfileScoresTheTestsAreaZero(t *testing.T) {
	original := copyProject(t, "lockfile-mismatch")

	r := realRun(t, context.Background(), "benchmark", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (the install is a Gate)\nstderr:\n%s", r.code, r.stderr)
	}
	b := r.set.Benchmark
	if b.Verdict == nil || *b.Verdict != resultset.VerdictFail || len(b.GateFindingIDs) == 0 {
		t.Errorf("verdict = %v, gates = %v, want fail", b.Verdict, b.GateFindingIDs)
	}
	tests := benchmarkArea(t, &r.set, "tests")
	if tests.Score == nil || *tests.Score != 0 {
		t.Errorf("tests area = %+v, want 0", tests)
	}
	p := benchmarkPart(t, &r.set, "pass_rate")
	if p.State != resultset.PartProjectFault || p.Reason == nil || *p.Reason != "prerequisite_failed_project" {
		t.Errorf("pass rate = %+v, want the project's fault", p)
	}
	if i := benchmarkPart(t, &r.set, "install"); i.Score == nil || *i.Score != 0 {
		t.Errorf("install = %+v, want 0", i)
	}
	// The Gate does not take the score away.
	if b.Score == nil {
		t.Errorf("no score although the project's fault counts as 0: %+v", b)
	}
	r.assertNothingLeft(t)
}

func TestBenchmarkMeasuresTypeErrorsOfAPackageWithTypeScriptFilesInsteadOfLeavingThemUnknown(t *testing.T) {
	original := copyProject(t, "types-mixed-ts")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "types.javascript")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	for _, s := range r.set.Benchmark.SideIndicators {
		if s.ID != "jsdoc_type_errors" {
			continue
		}
		if s.State != resultset.PartMeasured || s.Value == nil || *s.Value != 2 {
			t.Errorf("jsdoc_type_errors = %+v, want measured with the JSDoc mismatch and the TypeScript error", s)
		}
		return
	}
	t.Error("no jsdoc_type_errors side indicator")
}

func TestBenchmarkAndTestRunExactlyTheSameChecksWithTheSameExitCode(t *testing.T) {
	original := copyProject(t, "syntax-error")
	// tests.existing is left out: the test script names Mocha, which this project does not install.
	args := []string{original, "--exclude", "tests.existing"}

	tr := realRun(t, context.Background(), append([]string{"test"}, args...)...)
	br := realRun(t, context.Background(), append([]string{"benchmark"}, args...)...)

	if tr.code != 1 || br.code != 1 {
		t.Fatalf("exit codes: test %d, benchmark %d, want 1 for both\nbenchmark stderr:\n%s", tr.code, br.code, br.stderr)
	}
	got, want := executionKeys(&br.set), executionKeys(&tr.set)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("benchmark executions differ from test:\nbenchmark:\n%s\ntest:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if tr.set.Benchmark.Status != resultset.BenchmarkNotRequested || tr.set.Benchmark.Score != nil || tr.set.Benchmark.Range != nil || tr.set.Benchmark.Verdict != nil {
		t.Errorf("test mode benchmark = %+v, want not_requested", tr.set.Benchmark)
	}
	if md := string(mustRead(t, filepath.Join(tr.reportDir, "report.md"))); !strings.Contains(md, "No Benchmark score computed in test mode") {
		t.Error("the test mode report.md does not say that no score was computed")
	}

	// The Gate decides the Verdict and nothing else.
	if v := br.set.Benchmark.Verdict; v == nil || *v != resultset.VerdictFail {
		t.Errorf("verdict = %v, want fail", v)
	}
	if p := benchmarkPart(t, &br.set, "syntax"); p.Score == nil || *p.Score != 50 {
		t.Errorf("syntax = %+v, want 50: one source file fails to parse and the one in Test data does not count", p)
	}
	for _, r := range []*dockerRun{tr, br} {
		r.assertNothingLeft(t)
	}
	_ = os.Stdout
}
