//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for types.strictness.

func metricNamed(s *resultset.Set, check, name string) *resultset.Metric {
	for i := range s.Metrics {
		if s.Metrics[i].CheckID == check && s.Metrics[i].Name == name {
			return &s.Metrics[i]
		}
	}
	return nil
}

func TestTypesStrictnessMeasuresTypeCoverageAndReportsTheStrictOnlyErrorAsANote(t *testing.T) {
	original := copyProject(t, "typed-js")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "types.strictness")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: strict-gap errors are notes and never Gates\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}

	exec := oneExecution(t, &r.set, "types.strictness")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("types.strictness = %+v\nstderr:\n%s", exec, r.stderr)
	}
	if exec.Tool == nil || exec.Tool.Name != "tsc6" || exec.Tool.Version == nil || *exec.Tool.Version != "6.0.2" {
		t.Errorf("tool = %+v, want TypeScript 6 at the pinned 6.0.2", exec.Tool)
	}
	if command := strings.Join(exec.Command, " "); !strings.Contains(command, "typescript6/bin/tsc6") || !strings.Contains(command, "-p /jspf/tsconfig.strict.json") {
		t.Errorf("command = %q", command)
	}
	found := false
	for _, id := range r.set.Selection.PrerequisitesRun {
		found = found || id == "package.install"
	}
	if !found {
		t.Errorf("prerequisites_run = %v", r.set.Selection.PrerequisitesRun)
	}

	// The typed functions are covered and the untyped one is not.
	pct := metricNamed(&r.set, "types.strictness", "type_coverage_percent")
	if pct == nil || pct.Value == nil || *pct.Value <= 0 || *pct.Value >= 100 {
		t.Errorf("type_coverage_percent = %+v, want strictly between 0 and 100", pct)
	}
	if ids := metricNamed(&r.set, "types.strictness", "type_coverage_identifiers"); ids == nil || ids.Value == nil || *ids.Value <= 0 {
		t.Errorf("type_coverage_identifiers = %+v, want more than 0", ids)
	}
	if tc := metricNamed(&r.set, "types.strictness", "type_coverage_test_code_percent"); tc == nil || tc.Value == nil {
		t.Errorf("type_coverage_test_code_percent = %+v, want a value: Test code is measured on its own", tc)
	}
	if gap := metricNamed(&r.set, "types.strictness", "strict_gap_errors"); gap == nil || gap.Value == nil || *gap.Value != 1 {
		t.Errorf("strict_gap_errors = %+v, want 1", gap)
	}

	got := findingsOf(&r.set, "types.strictness")
	if len(got) != 1 {
		t.Fatalf("findings = %+v, want the one error that only strict mode reports", got)
	}
	f := got[0]
	if f.RuleID == nil || *f.RuleID != "TS7006" || f.Gate || f.Severity != resultset.SeverityNote || f.Confidence != resultset.ConfidenceSuspected {
		t.Errorf("finding = %+v, want a suspected TS7006 note without Gate", f)
	}
	if f.Locations[0].Path != "src/untyped.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 5 {
		t.Errorf("location = %+v", f.Locations[0])
	}
	if artifactOf(&r.set, exec, "C-0002-tsconfig-strict.json") == nil {
		t.Errorf("no strict tsconfig artifact: %+v", r.set.Artifacts)
	}
}

func TestBenchmarkScoresTypeCoverageAsItsPercentageAndShowsTheStrictGapAsASideIndicator(t *testing.T) {
	original := copyProject(t, "typed-js")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "types.strictness")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	pct := metricNamed(&r.set, "types.strictness", "type_coverage_percent")
	part := benchmarkPart(t, &r.set, "type_coverage")
	if pct == nil || pct.Value == nil || part.State != resultset.PartMeasured || part.Score == nil {
		t.Fatalf("metric %+v, part %+v", pct, part)
	}
	if got, want := *part.Score, float64(int(*pct.Value*10+0.5))/10; got != want {
		t.Errorf("part score = %v, want the percentage %v as it is", got, want)
	}
	for _, s := range r.set.Benchmark.SideIndicators {
		if s.ID != "strict_gap_errors" {
			continue
		}
		if s.State != resultset.PartMeasured || s.Value == nil || *s.Value != 1 {
			t.Errorf("strict_gap_errors = %+v, want measured with 1", s)
		}
		fp := r.set.Benchmark.Fingerprint
		if fp == nil || fp.Fields.TypeScript6Version == nil || *fp.Fields.TypeScript6Version != "6.0.2" {
			t.Errorf("fingerprint = %+v, want the TypeScript 6 version", fp)
		}
		r.assertNothingLeft(t)
		return
	}
	t.Error("no strict_gap_errors side indicator")
}
