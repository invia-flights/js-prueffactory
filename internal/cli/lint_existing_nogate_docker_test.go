//go:build docker

package cli_test

import (
	"context"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon: ESLint as a dependency without any
// configuration is no linter setup that could fail. realRun validates the
// Report against its schema and for consistency.

func TestLintExistingDoesNotApplyToESLintWithoutAnyConfigurationAndFiresNoGate(t *testing.T) {
	original := copyProject(t, "eslint-no-config")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.existing")

	if r.code != 0 || r.reportDir == "" {
		t.Fatalf("exit = %d, want 0: the project has no linter setup that could fail\nstderr:\n%s", r.code, r.stderr)
	}
	var seen bool
	for _, e := range r.set.Checks {
		if e.CheckID != "lint.existing" {
			continue
		}
		seen = true
		if e.Applicability != resultset.NotApplicable || e.Gate != 0 {
			t.Errorf("lint.existing = %+v, want not_applicable without a Gate", e)
		}
	}
	if !seen {
		t.Error("the Report holds no lint.existing execution")
	}
	if got := findingsOf(&r.set, "lint.existing"); len(got) != 0 {
		t.Errorf("findings = %+v, want none", got)
	}
	r.assertNothingLeft(t)
}
