//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A for the Checks that read the ESLint run, on the made-up project
// `unparsable-syntax`: Flow and JSX files that the toolset's ESLint cannot
// parse, next to files it can. 0 hits in a file nobody read is not a
// measurement, so the Checks are partial and the Benchmark treats their parts
// as unknown.

func TestChecksThatCouldNotParseFilesArePartialAndTheirBenchmarkPartsAreUnknown(t *testing.T) {
	original := copyProject(t, "unparsable-syntax")

	r := realRun(t, context.Background(), "benchmark", original)

	for _, id := range []string{"lint.correctness", "deps.engines", "tests.smells"} {
		var exec *resultset.Execution
		for i := range r.set.Checks {
			if r.set.Checks[i].CheckID == id && r.set.Checks[i].ContextID == "C-0002" {
				exec = &r.set.Checks[i]
			}
		}
		if exec == nil || exec.Status != resultset.StatusPartial || exec.ReasonCode == nil || *exec.ReasonCode != "files_not_parsed" {
			t.Fatalf("%s = %+v, want partial with files_not_parsed\nstderr:\n%s", id, exec, r.stderr)
		}
		// Two Source files (flow.js, view.js) and one Test file (flow.test.js) hold
		// syntax ESLint rejects; tests.smells looks at Test code only.
		want := "could not parse 3 files"
		if id == "tests.smells" {
			want = "could not parse 1 file"
		}
		if exec.Reason == nil || !strings.Contains(*exec.Reason, want) {
			t.Errorf("%s reason = %v, want it to contain %q", id, deref(exec.Reason), want)
		}
	}

	// The Finding in the file that parsed is kept.
	var hits []string
	for _, f := range findingsOf(&r.set, "lint.correctness") {
		hits = append(hits, f.Locations[0].Path)
	}
	if strings.Join(hits, ",") != "src/ok.js" {
		t.Errorf("lint.correctness hits = %v, want only src/ok.js", hits)
	}
	for _, f := range r.set.Limitations {
		if f.ReasonCode == "files_not_parsed" && f.CheckID != nil && *f.CheckID == "lint.correctness" &&
			!(strings.Contains(f.Message, "src/flow.js") && strings.Contains(f.Message, "src/view.js") && strings.Contains(f.Message, "test/flow.test.js")) {
			t.Errorf("limitation = %q, want the three files named", f.Message)
		}
	}

	for _, id := range []string{"correctness_lint", "node_compatibility", "smells"} {
		p := benchmarkPart(t, &r.set, id)
		if p.State != resultset.PartUnknown || p.Score != nil || p.Reason == nil || *p.Reason != "partial: files_not_parsed" {
			t.Errorf("part %s = %+v, want unknown with the reason partial: files_not_parsed", id, p)
		}
	}
	// Unknown parts mean no single score: the Tests area holds smells.
	if r.set.Benchmark.Score != nil {
		t.Errorf("score = %v, want none while a Tests part is unknown", *r.set.Benchmark.Score)
	}
	if r.set.Benchmark.Range.Low >= r.set.Benchmark.Range.High {
		t.Errorf("range = %v to %v, want a range", r.set.Benchmark.Range.Low, r.set.Benchmark.Range.High)
	}
	r.assertNothingLeft(t)
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
