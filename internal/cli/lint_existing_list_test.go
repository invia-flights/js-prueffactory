package cli_test

import (
	"path/filepath"
	"strings"
	"testing"
)

// Seam A without Docker: list-checks says whether lint.existing applies to a
// package that has ESLint as a dependency, and why not.

func lintExistingApplicability(t *testing.T, project string) (applicability, reason string) {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", project))
	if err != nil {
		t.Fatal(err)
	}
	l := listChecksJSON(t, dir, "--format", "json")
	for _, a := range l.Checks[rowOf(t, l, "lint.existing")].Applicability {
		if a.Kind == "package" && a.Path == "." {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("lint.existing has no applicability for the package")
	return "", ""
}

func TestListChecksShowsLintExistingNotApplicableForESLintWithoutAnyConfiguration(t *testing.T) {
	got, reason := lintExistingApplicability(t, "eslint-no-config")

	if got != "not_applicable" {
		t.Fatalf("applicability = %q (%s), want not_applicable", got, reason)
	}
	if !strings.Contains(reason, "ESLint is a dependency") || !strings.Contains(reason, "no ESLint configuration") {
		t.Errorf("reason = %q, want it to say ESLint is a dependency but there is no configuration", reason)
	}
}

func TestListChecksKeepsLintExistingApplicableForALegacyESLintConfiguration(t *testing.T) {
	if got, reason := lintExistingApplicability(t, "eslint-legacy"); got != "applicable" {
		t.Errorf("applicability = %q (%s), want applicable: the legacy configuration is a project error to report", got, reason)
	}
}

func TestListChecksKeepsLintExistingApplicableForAConfiguredESLint(t *testing.T) {
	if got, reason := lintExistingApplicability(t, "project-eslint"); got != "applicable" {
		t.Errorf("applicability = %q (%s), want applicable", got, reason)
	}
}
