package cli_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/cli"
)

// listJSON is the part of `list-checks --format json` the tests read.
type listJSON struct {
	CatalogVersion string `json:"catalog_version"`
	Fast           bool   `json:"fast"`
	Checks         []struct {
		ID            string `json:"id"`
		Family        string `json:"family"`
		Status        string `json:"status"`
		CanFireGates  bool   `json:"can_fire_gates"`
		BenchmarkArea string `json:"benchmark_area"`
		Selected      bool   `json:"selected"`
		SkippedByFast bool   `json:"skipped_by_fast"`
		Applicability []struct {
			ContextID     string `json:"context_id"`
			Kind          string `json:"kind"`
			Path          string `json:"path"`
			Applicability string `json:"applicability"`
			Reason        string `json:"reason"`
		} `json:"applicability"`
	} `json:"checks"`
}

// noDockerEnv is an environment in which a Docker lookup would fail, so a command
// that succeeds in it never contacted Docker.
func noDockerEnv(t *testing.T) map[string]string {
	t.Helper()
	return map[string]string{"PATH": t.TempDir(), "TMPDIR": t.TempDir(), "XDG_STATE_HOME": filepath.Join(t.TempDir(), "state")}
}

// plannedCheck is a Check ID that is planned for as long as the test runs, so
// that the tests of planned Checks name no Check that a ticket implements. It
// returns the Catalog the command line now uses.
const plannedCheck = "api.dast"

func withAPlannedCheck(t *testing.T) []checks.Entry {
	t.Helper()
	entries := checks.Catalog()
	for i := range entries {
		if entries[i].ID == plannedCheck {
			entries[i].Status = checks.Planned
		}
	}
	cli.UseCatalog(t, entries)
	return entries
}

func listChecksJSON(t *testing.T, args ...string) listJSON {
	t.Helper()
	r := call(t, noDockerEnv(t), append([]string{"list-checks"}, args...)...)
	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	var out listJSON
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, r.stdout)
	}
	return out
}

func rowOf(t *testing.T, l listJSON, id string) int {
	t.Helper()
	for i, c := range l.Checks {
		if c.ID == id {
			return i
		}
	}
	t.Fatalf("%s is not listed", id)
	return -1
}

func TestListChecksPrintsAMarkdownTableByDefaultWithoutDockerOrFiles(t *testing.T) {
	dir := project(t)
	env := noDockerEnv(t)
	before := treeListing(t, dir)

	r := call(t, env, "list-checks", dir)

	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	lines := strings.Split(r.stdout, "\n")
	header := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "| Check") {
			header = l
			break
		}
	}
	for _, col := range []string{"Check", "Family", "Status", "Gates", "Benchmark area", "Selected", "Applicability"} {
		if !strings.Contains(header, col) {
			t.Errorf("table header %q misses column %q\n%s", header, col, r.stdout)
		}
	}
	// The whole Catalog is listed, planned Checks included.
	for _, e := range checks.Catalog() {
		if !strings.Contains(r.stdout, "`"+e.ID+"`") {
			t.Errorf("%s is missing from the table", e.ID)
		}
	}
	if !strings.Contains(r.stdout, "planned") || !strings.Contains(r.stdout, "implemented") {
		t.Errorf("catalog status is not shown:\n%s", r.stdout)
	}
	if r.stderr != "" {
		t.Errorf("stderr = %q", r.stderr)
	}
	if after := treeListing(t, dir); after != before {
		t.Errorf("the project changed:\n%s\n--\n%s", before, after)
	}
	for _, d := range []string{env["TMPDIR"], filepath.Dir(env["XDG_STATE_HOME"])} {
		entries, _ := os.ReadDir(d)
		if len(entries) != 0 {
			t.Errorf("list-checks wrote into %s: %v", d, entries)
		}
	}
}

func treeListing(t *testing.T, dir string) string {
	t.Helper()
	var b strings.Builder
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		info, _ := d.Info()
		b.WriteString(p + " " + info.ModTime().String() + "\n")
		return nil
	})
	return b.String()
}

func TestListChecksJSONHasOneRowPerCatalogCheckWithApplicabilityPerContext(t *testing.T) {
	dir := project(t) // one package at the root with index.js
	catalog := withAPlannedCheck(t)
	l := listChecksJSON(t, dir, "--format", "json")

	if l.CatalogVersion != checks.CatalogVersion {
		t.Errorf("catalog_version = %q", l.CatalogVersion)
	}
	if len(l.Checks) != len(catalog) {
		t.Fatalf("%d rows, the Catalog has %d Checks", len(l.Checks), len(catalog))
	}
	for i, e := range catalog {
		row := l.Checks[i]
		if row.ID != e.ID || row.Family != e.Family || row.Status != string(e.Status) ||
			row.CanFireGates != e.CanFireGates || row.BenchmarkArea != e.Area {
			t.Errorf("row %d = %+v, catalog says %+v", i, row, e)
		}
	}

	sp := l.Checks[rowOf(t, l, "syntax.parse")]
	if sp.Status != "implemented" || !sp.CanFireGates || !sp.Selected {
		t.Errorf("syntax.parse row = %+v", sp)
	}
	if len(sp.Applicability) != 1 || sp.Applicability[0].Kind != "package" || sp.Applicability[0].Path != "." ||
		sp.Applicability[0].Applicability != "applicable" || sp.Applicability[0].ContextID == "" {
		t.Errorf("syntax.parse applicability = %+v", sp.Applicability)
	}

	// A planned Check is listed, never selected, and has nothing to apply to.
	planned := l.Checks[rowOf(t, l, plannedCheck)]
	if planned.Status != "planned" || planned.Selected || len(planned.Applicability) != 0 {
		t.Errorf("%s row = %+v", plannedCheck, planned)
	}
}

func TestListChecksGivesAReasonWhenACheckDoesNotApply(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "empty")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	l := listChecksJSON(t, dir, "--format", "json")
	sp := l.Checks[rowOf(t, l, "syntax.parse")]
	if len(sp.Applicability) != 1 || sp.Applicability[0].Applicability != "not_applicable" || sp.Applicability[0].Reason == "" {
		t.Errorf("syntax.parse applicability = %+v", sp.Applicability)
	}
	if sp.Applicability[0].Kind != "project" {
		t.Errorf("a project without packages answers in the project Context: %+v", sp.Applicability[0])
	}
}

func TestListChecksShowsTheSelectionOfOnlyAndExclude(t *testing.T) {
	dir := project(t)
	l := listChecksJSON(t, dir, "--format", "json", "--only", "syntax.parse")
	for _, c := range l.Checks {
		if want := c.ID == "syntax.parse"; c.Selected != want {
			t.Errorf("--only syntax.parse: %s selected = %v", c.ID, c.Selected)
		}
	}

	// --exclude leaves out its family. With syntax.parse as the only implemented
	// Check that would be an empty Selection, which is a usage error instead.
	if len(checks.ImplementedIDs()) > 1 {
		l = listChecksJSON(t, dir, "--format", "json", "--exclude", "syntax")
		if l.Checks[rowOf(t, l, "syntax.parse")].Selected {
			t.Error("--exclude syntax: syntax.parse is still selected")
		}
	}

	// Planned Checks are never selected, with or without flags.
	withAPlannedCheck(t)
	l = listChecksJSON(t, dir, "--format", "json")
	if l.Checks[rowOf(t, l, plannedCheck)].Selected {
		t.Error("a planned Check is selected")
	}

	// Markdown shows the same Selection.
	r := call(t, noDockerEnv(t), "list-checks", dir, "--only", "syntax.parse")
	var syntaxRow string
	for _, line := range strings.Split(r.stdout, "\n") {
		if strings.Contains(line, "`syntax.parse`") {
			syntaxRow = line
		}
	}
	if !strings.Contains(syntaxRow, "yes") {
		t.Errorf("syntax.parse row does not show the Check as selected: %q", syntaxRow)
	}
}

func TestListChecksRepeatedAndCommaSeparatedFlagsAgree(t *testing.T) {
	dir := project(t)
	a := listChecksJSON(t, dir, "--format", "json", "--only", "syntax.parse,syntax")
	b := listChecksJSON(t, dir, "--format", "json", "--only", "syntax.parse", "--only", "syntax")
	for i := range a.Checks {
		if a.Checks[i].Selected != b.Checks[i].Selected {
			t.Errorf("%s: comma list selects %v, repeated flag %v", a.Checks[i].ID, a.Checks[i].Selected, b.Checks[i].Selected)
		}
	}
}

func TestListChecksAndTestRejectBadSelectionsAndFormatsWithExitThree(t *testing.T) {
	dir := project(t)
	withAPlannedCheck(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"unknown ID", []string{"--only", "tests.exsting"}, "unknown Check or family"},
		{"unknown family", []string{"--only", "bogus"}, "unknown Check or family"},
		{"unknown exclude", []string{"--exclude", "bogus"}, "unknown Check or family"},
		{"planned Check", []string{"--only", plannedCheck}, "planned"},
		{"empty name", []string{"--only", "syntax.parse,"}, "empty"},
		{"empty Selection", []string{"--only", "syntax.parse", "--exclude", "syntax.parse"}, "no Checks"},
	}
	for _, command := range []string{"list-checks", "test"} {
		for _, tc := range cases {
			t.Run(command+" "+tc.name, func(t *testing.T) {
				// No docker on PATH: the error must come before the Docker lookup.
				r := call(t, map[string]string{"PATH": t.TempDir()}, append([]string{command, dir}, tc.args...)...)
				if r.code != 3 {
					t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
				}
				if r.stdout != "" {
					t.Errorf("stdout = %q", r.stdout)
				}
				if !strings.Contains(r.stderr, tc.want) {
					t.Errorf("stderr %q does not mention %q", r.stderr, tc.want)
				}
				if strings.Contains(r.stderr, "docker CLI") {
					t.Errorf("a Selection error must come before Docker: %s", r.stderr)
				}
			})
		}
	}
}

func TestListChecksUsageErrors(t *testing.T) {
	dir := project(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"output-dir", []string{"list-checks", dir, "--output-dir", t.TempDir()}, "output-dir"},
		{"budget", []string{"list-checks", dir, "--budget", "5m"}, "budget"},
		{"json,markdown", []string{"list-checks", dir, "--format", "json,markdown"}, "--format"},
		{"bad format", []string{"list-checks", dir, "--format", "xml"}, "--format"},
		{"empty format", []string{"list-checks", dir, "--format", ""}, "--format"},
		{"missing path", []string{"list-checks"}, "project path"},
		{"two paths", []string{"list-checks", dir, dir}, "exactly one"},
		{"no such folder", []string{"list-checks", filepath.Join(dir, "nope")}, "not a directory"},
		{"unknown flag", []string{"list-checks", dir, "--bogus"}, "bogus"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := call(t, noDockerEnv(t), tc.args...)
			if r.code != 3 || r.stdout != "" {
				t.Fatalf("exit %d, stdout %q, stderr %q", r.code, r.stdout, r.stderr)
			}
			if !strings.Contains(r.stderr, tc.want) {
				t.Errorf("stderr %q does not mention %q", r.stderr, tc.want)
			}
		})
	}
}

func TestListChecksAcceptsFormatMarkdownAndJSONOnly(t *testing.T) {
	dir := project(t)
	for _, f := range []string{"markdown", "json"} {
		if r := call(t, noDockerEnv(t), "list-checks", dir, "--format", f); r.code != 0 {
			t.Errorf("--format %s: exit %d, stderr %q", f, r.code, r.stderr)
		}
	}
}
