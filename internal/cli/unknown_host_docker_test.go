//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// ADR-0004: a test that talks to a host the Run does not provide fails fast and
// visibly. On the Execution network a lookup of an unknown name takes 5 s by
// default, which is the testdata test's own 5 s timeout; with the resolver
// options every container gets, the test fails with the lookup error instead.
func TestATestThatRequestsAHostTheRunDoesNotProvideFailsWithALookupErrorNotATimeout(t *testing.T) {
	original := copyProject(t, "unknown-host")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want exactly one", fs)
	}
	var evidence strings.Builder
	for _, ev := range fs[0].Evidence {
		evidence.WriteString(ev.Text + "\n")
	}
	if !strings.Contains(evidence.String(), "EAI_AGAIN") && !strings.Contains(evidence.String(), "ENOTFOUND") {
		t.Errorf("the Evidence shows no lookup error:\n%s", &evidence)
	}
	if strings.Contains(evidence.String(), "Timeout of") {
		t.Errorf("the test ran into its timeout instead of failing the lookup:\n%s", &evidence)
	}
	if r.set.Summary.TestCases.Failed != 1 {
		t.Errorf("test cases = %+v, want one failed", r.set.Summary.TestCases)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed {
		t.Errorf("tests.existing = %+v", e)
	}
	r.assertNothingLeft(t)
}
