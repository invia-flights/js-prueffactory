package cli_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/cli"
)

// These are seam A tests without Docker for the --fast flag.

// fastCatalog is the real Catalog with tests.mutation and api.fuzz implemented,
// the way Specs B and C make them. api.dast stays planned.
func fastCatalog(t *testing.T) {
	t.Helper()
	entries := checks.Catalog()
	for i := range entries {
		if entries[i].ID == "tests.mutation" || entries[i].ID == "api.fuzz" {
			entries[i].Status = checks.Implemented
		}
	}
	cli.UseCatalog(t, entries)
}

func TestListChecksShowsWhichChecksFastSkips(t *testing.T) {
	dir := project(t)
	l := listChecksJSON(t, dir, "--format", "json")
	var marked []string
	for _, c := range l.Checks {
		if c.SkippedByFast {
			marked = append(marked, c.ID)
		}
	}
	if want := "tests.mutation api.fuzz api.dast"; strings.Join(marked, " ") != want {
		t.Errorf("skipped by --fast = %v, want %s", marked, want)
	}
	if l.Fast {
		t.Error("fast is true without --fast")
	}

	r := call(t, noDockerEnv(t), "list-checks", dir)
	var header string
	rows := map[string]string{}
	for _, line := range strings.Split(r.stdout, "\n") {
		if strings.HasPrefix(line, "| Check") {
			header = line
		}
		if cells := strings.Split(line, "|"); strings.HasPrefix(line, "| `") && len(cells) > 2 {
			rows[strings.Trim(strings.TrimSpace(cells[1]), "`")] = line
		}
	}
	if !strings.Contains(header, "Skipped by `--fast`") {
		t.Fatalf("table header %q has no column for --fast", header)
	}
	column := -1
	for i, h := range strings.Split(header, "|") {
		if strings.Contains(h, "Skipped by") {
			column = i
		}
	}
	for _, c := range l.Checks {
		cell := strings.TrimSpace(strings.Split(rows[c.ID], "|")[column])
		if want := map[bool]string{true: "yes", false: "no"}[c.SkippedByFast]; cell != want {
			t.Errorf("%s: Skipped by --fast cell = %q, want %q", c.ID, cell, want)
		}
	}
}

func TestFastWorksWithEveryCommandAndNeverTripsOverAPlannedMarkedCheck(t *testing.T) {
	dir := project(t)
	// Every Check marked for --fast is planned, whatever the real Catalog says.
	entries := checks.Catalog()
	for i := range entries {
		if entries[i].SkippedByFast {
			entries[i].Status = checks.Planned
		}
	}
	cli.UseCatalog(t, entries)
	// The Checks --fast skips are all still planned: it removes nothing and the
	// Selection is the same.
	l := listChecksJSON(t, dir, "--format", "json", "--fast")
	if !l.Fast {
		t.Error("list-checks --fast does not say that --fast was given")
	}
	plain := listChecksJSON(t, dir, "--format", "json")
	for i := range l.Checks {
		if l.Checks[i].Selected != plain.Checks[i].Selected {
			t.Errorf("%s: selected %v with --fast, %v without", l.Checks[i].ID, l.Checks[i].Selected, plain.Checks[i].Selected)
		}
	}
	for _, command := range []string{"test", "benchmark"} {
		r := call(t, noDocker(t, nil), command, dir, "--fast")
		if strings.Contains(r.stderr, "planned") || !strings.Contains(r.stderr, "budget 30m0s (fast_default)") {
			t.Errorf("%s --fast: stderr %q", command, r.stderr)
		}
	}
	// Naming a planned Check is still an error, with --fast too.
	r := call(t, noDocker(t, nil), "test", dir, "--fast", "--only", "tests.mutation")
	if r.code != 3 || !strings.Contains(r.stderr, "planned") {
		t.Errorf("exit %d, stderr %q", r.code, r.stderr)
	}
}

func TestListChecksFastShowsTheResultingSelection(t *testing.T) {
	fastCatalog(t)
	dir := project(t)

	plain := listChecksJSON(t, dir, "--format", "json")
	for _, id := range []string{"tests.mutation", "api.fuzz"} {
		if !plain.Checks[rowOf(t, plain, id)].Selected {
			t.Errorf("%s is not selected without --fast", id)
		}
	}

	l := listChecksJSON(t, dir, "--format", "json", "--fast")
	for _, id := range []string{"tests.mutation", "api.fuzz", "api.dast"} {
		row := l.Checks[rowOf(t, l, id)]
		if row.Selected || !row.SkippedByFast {
			t.Errorf("%s with --fast: %+v", id, row)
		}
	}
	if !l.Checks[rowOf(t, l, "syntax.parse")].Selected {
		t.Error("--fast deselected syntax.parse")
	}
}

func TestFastRemovesSkippedChecksAfterOnlyAndExclude(t *testing.T) {
	fastCatalog(t)
	dir := project(t)

	// --only names a skipped Check and a kept one.
	l := listChecksJSON(t, dir, "--format", "json", "--fast", "--only", "tests.mutation,syntax.parse")
	for _, c := range l.Checks {
		if want := c.ID == "syntax.parse"; c.Selected != want {
			t.Errorf("--fast --only tests.mutation,syntax.parse: %s selected = %v", c.ID, c.Selected)
		}
	}

	// --exclude and --fast together.
	l = listChecksJSON(t, dir, "--format", "json", "--fast", "--exclude", "syntax")
	if l.Checks[rowOf(t, l, "syntax.parse")].Selected || l.Checks[rowOf(t, l, "tests.mutation")].Selected {
		t.Error("--fast --exclude syntax left syntax.parse or tests.mutation selected")
	}
	if !l.Checks[rowOf(t, l, "package.manifest")].Selected {
		t.Error("--fast --exclude syntax deselected package.manifest")
	}
}

func TestFastThatEmptiesTheSelectionIsAUsageError(t *testing.T) {
	fastCatalog(t)
	dir := project(t)
	for _, command := range []string{"list-checks", "test", "benchmark"} {
		t.Run(command, func(t *testing.T) {
			// No docker on PATH: the error must come before the Docker lookup.
			r := call(t, map[string]string{"PATH": t.TempDir()}, command, dir, "--fast", "--only", "tests.mutation,api.fuzz")
			if r.code != 3 || r.stdout != "" {
				t.Fatalf("exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
			}
			if !strings.Contains(r.stderr, "no Checks") || !strings.Contains(r.stderr, "--fast") || strings.Contains(r.stderr, "docker CLI") {
				t.Errorf("stderr %q", r.stderr)
			}
		})
	}
	// Without --fast the same call selects them.
	if r := call(t, noDockerEnv(t), "list-checks", dir, "--only", "tests.mutation,api.fuzz"); r.code != 0 {
		t.Errorf("without --fast: exit %d, stderr %q", r.code, r.stderr)
	}
}
