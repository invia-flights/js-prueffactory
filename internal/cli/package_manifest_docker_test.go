//go:build docker

package cli_test

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of package.manifest. The Check itself needs no container, but
// the testdata projects also run syntax.parse, so these need a Docker daemon.

func manifestExecution(t *testing.T, s *resultset.Set) resultset.Execution {
	t.Helper()
	var got []resultset.Execution
	for _, e := range s.Checks {
		if e.CheckID == "package.manifest" && e.Applicability != resultset.NotApplicable {
			got = append(got, e)
		}
	}
	if len(got) != 1 {
		t.Fatalf("package.manifest executions = %+v, want one", got)
	}
	return got[0]
}

func TestLockfileMismatchGetsTheManifestGate(t *testing.T) {
	original := copyProject(t, "lockfile-mismatch")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	exec := manifestExecution(t, &r.set)
	if exec.Status != resultset.StatusCompleted || exec.Gate != 1 {
		t.Errorf("package.manifest = status %s, %d Gates; want completed with 1 Gate", exec.Status, exec.Gate)
	}
	findings := findingsOf(&r.set, "package.manifest")
	if len(findings) != 1 {
		t.Fatalf("findings = %+v", findings)
	}
	f := findings[0]
	if f.RuleID == nil || *f.RuleID != "lockfile-missing-dependency" || !f.Gate || f.Severity != resultset.SeverityError {
		t.Errorf("finding = %+v", f)
	}
	if f.Locations[0].Path != "package.json" || f.Expected == nil || *f.Expected != "^1.3.0" {
		t.Errorf("finding = %+v", f)
	}
	r.assertNothingLeft(t)
}

func TestNoLockfileGetsTheManifestWarning(t *testing.T) {
	original := copyProject(t, "no-lockfile")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: a missing lockfile is only a warning\nstderr:\n%s", r.code, r.stderr)
	}
	exec := manifestExecution(t, &r.set)
	if exec.Status != resultset.StatusCompleted || exec.Gate != 0 {
		t.Errorf("package.manifest = status %s, %d Gates", exec.Status, exec.Gate)
	}
	findings := findingsOf(&r.set, "package.manifest")
	if len(findings) != 1 {
		t.Fatalf("findings = %+v", findings)
	}
	f := findings[0]
	if f.RuleID == nil || *f.RuleID != "lockfile-missing" || f.Gate || f.Severity != resultset.SeverityWarning {
		t.Errorf("finding = %+v", f)
	}
	r.assertNothingLeft(t)
}
