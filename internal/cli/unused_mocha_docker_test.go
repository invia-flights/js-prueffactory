//go:build docker

package cli_test

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of quality.unused on a package whose Mocha configs live under
// test/config, with a real Docker daemon, the toolset volume and the public npm
// registry.

// unusedSummary lists what quality.unused reports, as "rule evidence" lines.
func unusedSummary(s *resultset.Set) []string {
	var out []string
	for _, f := range findingsOf(s, "quality.unused") {
		out = append(out, *f.RuleID+" "+f.Evidence[0].Text)
	}
	sort.Strings(out)
	return out
}

func TestKnipKnowsWhatMochaConfigsLoadAndWhatCIScriptsRun(t *testing.T) {
	original := copyProject(t, "mocha-config-unused")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "quality.unused"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	// The setup files and the helper only they import are used, the reporter
	// is a dependency that is used, and so is c8, which only ci/test.sh runs.
	// What is really unused is still reported.
	got := unusedSummary(&r.set)
	want := []string{"unused-dependency is-odd", "unused-file src/unused.js"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("quality.unused findings = %q, want %q", got, want)
	}
	for _, l := range r.set.Limitations {
		if l.CheckID != nil && *l.CheckID == "quality.unused" {
			t.Errorf("a Limitation without a project Knip config: %+v", l)
		}
	}
	r.assertNothingLeft(t)
}

// A test script that names folders, with `recursive` in the config, loads specs
// that Knip does not find. Without the correction it reports every one of them,
// and the sources only they import, as unused files.
func TestSpecsOfAFolderTheTestScriptNamesAreNotReportedAsUnusedFiles(t *testing.T) {
	original := copyProject(t, "mocha-test-folder")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused,tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	var files []string
	for _, line := range unusedSummary(&r.set) {
		if strings.HasPrefix(line, "unused-file ") {
			files = append(files, line)
		}
	}
	if want := []string{"unused-file src/unused.js"}; strings.Join(files, "\n") != strings.Join(want, "\n") {
		t.Errorf("unused files = %q, want %q (the nested spec and src/lib/double.js are used)", files, want)
	}
	r.assertNothingLeft(t)
}

func TestWithTheProjectsOwnKnipConfigTheCorrectionsHoldAndTheReportSaysWhatItCannotSee(t *testing.T) {
	original := copyProject(t, "mocha-config-unused")
	writeUnusedCyclesFile(t, filepath.Join(original, "knip.json"), "{}\n")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	// No false unresolved imports, no unused setup files, no unused reporter or
	// c8. The helper that only the setup files import is still reported: the
	// project's own config is not rewritten, so Knip cannot be told.
	got := unusedSummary(&r.set)
	want := []string{"unused-dependency is-odd", "unused-file src/unused.js", "unused-file test/helpers/only-setup.js"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("quality.unused findings = %q, want %q", got, want)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "mocha_loaded_files_not_traced" && l.CheckID != nil && *l.CheckID == "quality.unused" &&
			strings.Contains(l.Message, "test/setup/base.js") {
			limited = true
		}
	}
	if !limited {
		t.Errorf("limitations = %+v, want mocha_loaded_files_not_traced", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}
