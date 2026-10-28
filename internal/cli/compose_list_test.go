package cli_test

import (
	"os"
	"path/filepath"
	"testing"
)

// Seam A without Docker: list-checks says that repository.compose applies to
// the project when its root holds compose files, which make the compose sets.

func composeApplicability(t *testing.T, dir string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, dir, "--format", "json")
	row := l.Checks[rowOf(t, l, "repository.compose")]
	if row.Status != "implemented" {
		t.Errorf("status = %q, want implemented", row.Status)
	}
	for _, a := range row.Applicability {
		if a.Kind == "project" {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("repository.compose has no applicability for the project")
	return "", ""
}

func projectWithFiles(t *testing.T, files ...string) string {
	t.Helper()
	dir := t.TempDir()
	files = append(files, "package.json")
	for _, rel := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		content := "services: {}\n"
		if rel == "package.json" {
			content = `{"name": "x", "version": "1.0.0"}` + "\n"
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestListChecksShowsComposeApplicableWithComposeFilesAtTheRoot(t *testing.T) {
	cases := map[string]string{
		"ci-files (a default set, a set of its own and a remote include)": testdataProject(t, "ci-files"),
		"a base file alone":                           projectWithFiles(t, "docker-compose.yml"),
		"an override file without a base file":        projectWithFiles(t, "compose.override.yaml"),
		"a file that only starts like a compose file": projectWithFiles(t, "compose-notes.yml"),
	}
	for name, dir := range cases {
		if got, reason := composeApplicability(t, dir); got != "applicable" || reason != "" {
			t.Errorf("%s: applicability = %q (%s), want applicable", name, got, reason)
		}
	}
}

func TestListChecksShowsComposeNotApplicableWithoutComposeFilesAtTheRoot(t *testing.T) {
	cases := map[string]string{
		"clean-mocha":                    testdataProject(t, "clean-mocha"),
		"a compose file in a subfolder":  projectWithFiles(t, "deploy/compose.yaml"),
		"a file that is no compose file": projectWithFiles(t, "my-compose.yaml", "compose.txt"),
	}
	for name, dir := range cases {
		if got, reason := composeApplicability(t, dir); got != "not_applicable" || reason == "" {
			t.Errorf("%s: applicability = %q (%s), want not_applicable with a reason", name, got, reason)
		}
	}
}
