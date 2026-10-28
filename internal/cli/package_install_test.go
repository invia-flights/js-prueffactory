package cli_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Seam A without Docker: what list-checks says about package.install and
// deps.tree for packages whose install this release does not support.

// projectWith writes files into a new project folder and returns it.
func projectWith(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "demo")
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestPackageInstallAndDepsTreeAreImplemented(t *testing.T) {
	l := listChecksJSON(t, projectWith(t, map[string]string{"package.json": `{"name":"demo"}`}), "--format", "json")
	for _, id := range []string{"package.install", "deps.tree"} {
		if got := l.Checks[rowOf(t, l, id)]; got.Status != "implemented" || !got.Selected {
			t.Errorf("%s = %+v, want implemented and selected", id, got)
		}
	}
	if got := l.Checks[rowOf(t, l, "package.install")]; !got.CanFireGates {
		t.Error("package.install can fire Gates")
	}
}

func TestListChecksNamesWhyAPackageCannotBeInstalled(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string // text the reason holds
	}{
		{"pnpm lockfile", map[string]string{"package.json": `{"name":"demo"}`, "pnpm-lock.yaml": "lockfileVersion: 9\n"}, "pnpm-lock.yaml"},
		{"yarn lockfile", map[string]string{"package.json": `{"name":"demo"}`, "yarn.lock": "# yarn\n"}, "yarn.lock"},
		{"bun lockfile", map[string]string{"package.json": `{"name":"demo"}`, "bun.lockb": "x"}, "bun.lockb"},
		{"deno config", map[string]string{"package.json": `{"name":"demo"}`, "deno.json": "{}"}, "deno.json"},
		{"packageManager field", map[string]string{"package.json": `{"name":"demo","packageManager":"yarn@4.1.0"}`}, "packageManager"},
		{"workspace root", map[string]string{"package.json": `{"name":"demo","workspaces":["packages/*"]}`, "package-lock.json": `{"lockfileVersion":3,"packages":{}}`}, "workspaces"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := listChecksJSON(t, projectWith(t, c.files), "--format", "json")
			for _, id := range []string{"package.install", "deps.tree"} {
				row := l.Checks[rowOf(t, l, id)]
				if len(row.Applicability) != 1 {
					t.Fatalf("%s applicability = %+v", id, row.Applicability)
				}
				a := row.Applicability[0]
				if a.Applicability != "applicable" || !strings.Contains(a.Reason, "unsupported") || !strings.Contains(a.Reason, c.want) {
					t.Errorf("%s = %+v, want applicable with an unsupported reason naming %q", id, a, c.want)
				}
			}
		})
	}
}

func TestListChecksMarksWorkspaceMembersUnsupportedToo(t *testing.T) {
	dir := projectWith(t, map[string]string{
		"package.json":                  `{"name":"root","workspaces":["packages/*"]}`,
		"package-lock.json":             `{"lockfileVersion":3,"packages":{}}`,
		"packages/a/package.json":       `{"name":"a"}`,
		"packages/a/index.js":           "module.exports = 1;\n",
		"tools/standalone/package.json": `{"name":"standalone"}`,
	})
	l := listChecksJSON(t, dir, "--format", "json")
	byPath := map[string]string{}
	for _, a := range l.Checks[rowOf(t, l, "package.install")].Applicability {
		byPath[a.Path] = a.Reason
	}
	if !strings.Contains(byPath["packages/a"], "workspace") {
		t.Errorf("a workspace member must be unsupported too, got %q", byPath["packages/a"])
	}
	if byPath["tools/standalone"] != "" {
		t.Errorf("a package outside the workspaces is installable, got %q", byPath["tools/standalone"])
	}
}

func TestListChecksShowsNoReasonForAnInstallablePackage(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"npm lockfile": {"package.json": `{"name":"demo"}`, "package-lock.json": `{"lockfileVersion":3,"packages":{}}`},
		"shrinkwrap":   {"package.json": `{"name":"demo"}`, "npm-shrinkwrap.json": `{"lockfileVersion":3,"packages":{}}`},
		"no lockfile":  {"package.json": `{"name":"demo"}`},
	} {
		l := listChecksJSON(t, projectWith(t, files), "--format", "json")
		a := l.Checks[rowOf(t, l, "package.install")].Applicability[0]
		if a.Applicability != "applicable" || a.Reason != "" {
			t.Errorf("%s: package.install = %+v", name, a)
		}
	}
}
