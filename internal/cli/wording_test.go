package cli_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// Seam A without Docker: a reason says what js-prueffactory supports, never in
// which milestone. Readers of a Report don't know the milestones, and a reason
// that names one turns false when the next one starts.

// assertNamesNoMilestone fails when text names a milestone. The Catalog version
// is an identifier that list-checks and the Report show, not a reason, so it is
// left out.
func assertNamesNoMilestone(t *testing.T, where, text string) {
	t.Helper()
	text = strings.ReplaceAll(text, checks.CatalogVersion, "")
	if i := strings.Index(strings.ToLower(text), "milestone"); i >= 0 {
		start, end := max(0, i-80), min(len(text), i+80)
		t.Errorf("%s names a milestone: …%s…", where, text[start:end])
	}
}

func TestReasonsSayWhatTheToolSupportsAndNameNoMilestone(t *testing.T) {
	lock := `{"lockfileVersion":3,"packages":{}}`
	cases := []struct {
		name  string
		files map[string]string
		check string // the Check whose reason is read, or "" for the Node version of the package Context
		want  string // text the reason holds
	}{
		{"yarn lockfile", map[string]string{"package.json": `{"name":"demo"}`, "yarn.lock": "# yarn\n"},
			"package.install", "the package uses yarn (yarn.lock), and js-prueffactory supports only npm"},
		{"workspaces field", map[string]string{"package.json": `{"name":"demo","workspaces":["packages/*"]}`, "package-lock.json": lock},
			"package.install", "the package.json has a workspaces field, and js-prueffactory does not support npm workspaces"},
		{"jest test script", map[string]string{"package.json": `{"scripts":{"test":"jest --ci"}}`, "package-lock.json": lock},
			"tests.existing", "js-prueffactory runs only `mocha …` and `node … --test …`"},
		{"node version file", map[string]string{"package.json": `{"name":"demo"}`, ".nvmrc": "18\n"},
			"", "Node 18, declared in .nvmrc, is not supported: js-prueffactory runs Node "},
		{"engines.node", map[string]string{"package.json": `{"name":"demo","engines":{"node":"<18"}}`},
			"", "is satisfied by none of the supported Node majors: js-prueffactory runs Node "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := projectWith(t, c.files)
			var reason string
			if c.check == "" {
				cs := listedContexts(t, dir)
				reason = cs[len(cs)-1].NodeUnsupported
			} else {
				l := listChecksJSON(t, dir, "--format", "json")
				reason = l.Checks[rowOf(t, l, c.check)].Applicability[0].Reason
			}
			if !strings.Contains(reason, c.want) {
				t.Errorf("reason = %q, want it to hold %q", reason, c.want)
			}
			for _, format := range []string{"json", "markdown"} {
				r := call(t, noDockerEnv(t), "list-checks", dir, "--format", format)
				if r.code != 0 {
					t.Fatalf("list-checks --format %s: exit %d, stderr %q", format, r.code, r.stderr)
				}
				assertNamesNoMilestone(t, "list-checks --format "+format, r.stdout)
			}
		})
	}
}

func TestAWorkspaceMemberIsUnsupportedForWhatTheToolSupports(t *testing.T) {
	dir := projectWith(t, map[string]string{
		"package.json":            `{"name":"root","workspaces":["packages/*"]}`,
		"package-lock.json":       `{"lockfileVersion":3,"packages":{}}`,
		"packages/a/package.json": `{"name":"a"}`,
	})
	l := listChecksJSON(t, dir, "--format", "json")
	for _, a := range l.Checks[rowOf(t, l, "package.install")].Applicability {
		if a.Path != "packages/a" {
			continue
		}
		if want := "and js-prueffactory does not support npm workspaces"; !strings.Contains(a.Reason, want) {
			t.Errorf("reason = %q, want it to hold %q", a.Reason, want)
		}
		assertNamesNoMilestone(t, "the workspace member's reason", a.Reason)
		return
	}
	t.Fatal("the workspace member is not listed")
}

func TestSelectingAPlannedCheckIsRefusedWithoutNamingAMilestone(t *testing.T) {
	withAPlannedCheck(t)
	r := call(t, noDockerEnv(t), "list-checks", project(t), "--only", plannedCheck)
	if r.code != 3 || !strings.Contains(r.stderr, "planned") {
		t.Fatalf("exit %d, stderr %q, want 3 with the planned Check error", r.code, r.stderr)
	}
	assertNamesNoMilestone(t, "the error", r.stderr)
}

// TestNoTextInTheToolsSourceNamesAMilestone covers the texts a seam test
// reaches only through Docker, such as the Mocha version reason of
// tests.existing: no string literal in the tool's non-test Go code names a
// milestone. Comments may, because they explain history.
func TestNoTextInTheToolsSourceNamesAMilestone(t *testing.T) {
	for _, root := range []string{"..", filepath.Join("..", "..", "cmd")} {
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() && d.Name() == "testdata" {
				return filepath.SkipDir
			}
			if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			file, err := parser.ParseFile(token.NewFileSet(), p, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			ast.Inspect(file, func(n ast.Node) bool {
				if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING && lit.Value != strconv.Quote(checks.CatalogVersion) {
					assertNamesNoMilestone(t, p, lit.Value)
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
