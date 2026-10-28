package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests are seam B for the two native project Checks: they discover a
// testdata project, run the Check on it without Docker and look at the Result
// a Report is built from. The expected numbers were counted with wc, grep and
// shasum, not with the code under test.

const suppressionsProject = "../../testdata/projects/suppressions"

func runNativeCheck(t *testing.T, id, project string) *checks.Result {
	t.Helper()
	root, err := filepath.Abs(project)
	if err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	c := checks.Implementation(id)
	if c == nil {
		t.Fatalf("%s is not implemented", id)
	}
	ctx := &proj.Contexts[0]
	if got, why := c.Applicability(proj, ctx); got != resultset.Applicable {
		t.Fatalf("%s applicability = %s (%s)", id, got, why)
	}
	res := c.Run(context.Background(), &checks.Input{Project: proj, Context: ctx, SnapshotDir: root, OriginalPath: root})
	if res == nil || res.Status != resultset.StatusCompleted {
		t.Fatalf("%s result = %+v", id, res)
	}
	return res
}

func TestSizeAndSuppressionsAreImplementedProjectChecks(t *testing.T) {
	for _, id := range []string{"quality.size", "quality.suppressions"} {
		e, ok := checks.Lookup(id)
		if !ok || e.Status != checks.Implemented || e.Scope != checks.PerProject {
			t.Errorf("%s = %+v, want an implemented project Check", id, e)
		}
	}
}

func metricsByName(res *checks.Result) map[string]float64 {
	m := map[string]float64{}
	for _, x := range res.Metrics {
		if x.Value != nil {
			m[x.Name] = *x.Value
		}
	}
	return m
}

func TestSizeCountsLinesPerFileClassAndExtension(t *testing.T) {
	res := runNativeCheck(t, "quality.size", suppressionsProject)
	got := metricsByName(res)
	want := map[string]float64{
		"lines.file_class:source":                 47,
		"non_blank_lines.file_class:source":       45,
		"lines.file_class:test_code":              9,
		"non_blank_lines.file_class:test_code":    9,
		"lines.file_class:test_data":              5,
		"non_blank_lines.file_class:test_data":    5,
		"lines.file_class:build_output":           2,
		"non_blank_lines.file_class:build_output": 2,
		"lines.extension:.json":                   20,
		"non_blank_lines.extension:.json":         20,
		"lines.extension:.js":                     33,
		"non_blank_lines.extension:.js":           32,
		"lines.extension:.md":                     3,
		"non_blank_lines.extension:.md":           2,
		"lines.extension:.sh":                     3,
		"lines.extension:.env":                    1,
		"lines.extension:(none)":                  3, // the Dockerfile
	}
	for name, v := range want {
		if g, ok := got[name]; !ok || g != v {
			t.Errorf("metric %s = %v (present %v), want %v", name, g, ok, v)
		}
	}
}

func lines(n int) string { return strings.Repeat("x\n", n) }

// writeMixedProject writes a package with code, a lockfile, an OpenAPI file,
// Test data and Build output of known line counts.
func writeMixedProject(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeInventoryFile(t, root, "package.json", "{\"name\":\"p\",\"scripts\":{\"test\":\"mocha\"}}\n")
	writeInventoryFile(t, root, "src/a.js", lines(30))
	writeInventoryFile(t, root, "src/b.ts", lines(20))
	writeInventoryFile(t, root, "src/c.mjs", lines(10))
	writeInventoryFile(t, root, "src/d.cjs", lines(5))
	writeInventoryFile(t, root, "src/e.jsx", lines(4))
	writeInventoryFile(t, root, "src/f.cts", lines(3))
	writeInventoryFile(t, root, "src/g.mts", lines(2))
	writeInventoryFile(t, root, "src/h.tsx", lines(1))
	writeInventoryFile(t, root, "src/schema.json", lines(500))
	writeInventoryFile(t, root, "openapi.yaml", lines(400))
	writeInventoryFile(t, root, "package-lock.json", lines(900))
	writeInventoryFile(t, root, "test/app.test.js", lines(25))
	writeInventoryFile(t, root, "test/fixtures/big.js", lines(300))
	writeInventoryFile(t, root, "test/fixtures/data.json", lines(700))
	writeInventoryFile(t, root, "dist/bundle.js", lines(800))
	return root
}

func TestSizeCodeLinesIndicatorCountsOnlyJavaScriptAndTypeScriptFilesOfSourceCode(t *testing.T) {
	got := metricsByName(runNativeCheck(t, "quality.size", writeMixedProject(t)))

	// 30+20+10+5+4+3+2+1: no JSON, YAML, lockfile, Test code, Test data or Build output.
	if v := got["lines.source_code:javascript_typescript"]; v != 75 {
		t.Errorf("JavaScript and TypeScript lines in Source code = %v, want 75", v)
	}
	// The per-class and per-extension counts stay as they were.
	for name, want := range map[string]float64{
		"lines.file_class:source": 75 + 500 + 400 + 900 + 1, // the 1 is package.json "lines.file_class:test_code": 25,
		"lines.extension:.json":   500 + 900 + 700 + 1, "lines.extension:.yaml": 400, "lines.extension:.js": 30 + 25 + 300 + 800,
	} {
		if got[name] != want {
			t.Errorf("%s = %v, want %v", name, got[name], want)
		}
	}
}

func TestSizeCodeLinesIndicatorIsZeroWhenSourceCodeHasNoCode(t *testing.T) {
	root := t.TempDir()
	writeInventoryFile(t, root, "package.json", "{\"name\":\"p\"}\n")
	writeInventoryFile(t, root, "data.json", lines(10))
	got := metricsByName(runNativeCheck(t, "quality.size", root))
	if v, ok := got["lines.source_code:javascript_typescript"]; !ok || v != 0 {
		t.Errorf("lines = %v (present %v), want 0", v, ok)
	}
}

func TestSizeListsTheLargestJavaScriptAndTypeScriptFilesOfSourceAndTestCodeOnly(t *testing.T) {
	res := runNativeCheck(t, "quality.size", writeMixedProject(t))
	var largest []string
	for _, m := range res.Metrics {
		const p = "largest_file:"
		if strings.HasPrefix(m.Name, p) {
			largest = append(largest, m.Name[len(p):])
			if m.Unit != "lines" {
				t.Errorf("%s unit = %q, want lines", m.Name, m.Unit)
			}
		}
	}
	// Largest first; no JSON, YAML, lockfile, Test data or Build output.
	want := []string{"src/a.js", "test/app.test.js", "src/b.ts", "src/c.mjs", "src/d.cjs", "src/e.jsx", "src/f.cts", "src/g.mts", "src/h.tsx"}
	if strings.Join(largest, ",") != strings.Join(want, ",") {
		t.Errorf("largest files = %v, want %v", largest, want)
	}
}

func TestSizeStopsAtTwentyLargestFiles(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 25; i++ {
		writeInventoryFile(t, root, filepath.Join("src", string(rune('a'+i))+".js"), "x\n")
	}
	res := runNativeCheck(t, "quality.size", root)
	n := 0
	for _, m := range res.Metrics {
		if len(m.Name) > 13 && m.Name[:13] == "largest_file:" {
			n++
		}
	}
	if n != 20 {
		t.Errorf("listed %d largest files, want 20", n)
	}
}

func TestSizeInventoryMirrorsTheMetrics(t *testing.T) {
	res := runNativeCheck(t, "quality.size", suppressionsProject)
	if res.Inventory == nil {
		t.Fatal("no Inventory contribution")
	}
	var src, js *resultset.SizeCount
	for i, s := range res.Inventory.Size {
		switch {
		case s.Group == "file_class" && s.Name == "source":
			src = &res.Inventory.Size[i]
		case s.Group == "extension" && s.Name == ".js":
			js = &res.Inventory.Size[i]
		}
	}
	if src == nil || src.Lines != 47 || src.NonBlankLines != 45 {
		t.Errorf("source = %+v, want 47 lines, 45 non-blank", src)
	}
	if js == nil || js.Lines != 33 || js.NonBlankLines != 32 {
		t.Errorf(".js = %+v, want 33 lines, 32 non-blank", js)
	}
}

func TestSizeIgnoresBinaryFiles(t *testing.T) {
	root := t.TempDir()
	writeInventoryFile(t, root, "src/a.js", "one\ntwo")
	writeInventoryFile(t, root, "src/logo.png", "\x89PNG\x00\x00\n\n\n\n")
	got := metricsByName(runNativeCheck(t, "quality.size", root))
	if got["lines.file_class:source"] != 2 {
		t.Errorf("source lines = %v, want 2 (an unterminated last line counts, a PNG does not)", got["lines.file_class:source"])
	}
	if _, ok := got["lines.extension:.png"]; ok {
		t.Error("a binary extension has a line count")
	}
}

type suppressionKey struct{ kind, class string }

func suppressionCounts(inv *resultset.Inventory) map[suppressionKey]int {
	m := map[suppressionKey]int{}
	for _, s := range inv.Suppressions {
		m[suppressionKey{s.Kind, s.FileClass}] += s.Count
	}
	return m
}

func TestSuppressionsAreCountedByKindAndFileClassInSourceAndTestCodeOnly(t *testing.T) {
	res := runNativeCheck(t, "quality.suppressions", suppressionsProject)
	if res.Inventory == nil {
		t.Fatal("no Inventory contribution")
	}
	want := map[suppressionKey]int{
		{"eslint-disable", "source"}:       4, // block, next-line, line, and packages/lib
		{"biome-ignore", "source"}:         1,
		{"@ts-ignore", "source"}:           1,
		{"@ts-expect-error", "source"}:     1,
		{"@ts-nocheck", "source"}:          1,
		{"c8 ignore", "source"}:            1, // "c8 ignore stop" is no Suppression
		{"istanbul ignore", "source"}:      1,
		{"node:coverage ignore", "source"}: 1,
		{"gitleaks:allow", "source"}:       1,
		{"hadolint ignore", "source"}:      1,
		{"shellcheck disable", "source"}:   1,
		{"jscpd:ignore-start", "source"}:   1,
		{"stryker disable", "source"}:      1,
		{"eslint-disable", "test_code"}:    1,
		{"@ts-ignore", "test_code"}:        2,
		{"c8 ignore", "test_code"}:         1,
	}
	got := suppressionCounts(res.Inventory)
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%s in %s = %d, want %d", k.kind, k.class, got[k], n)
		}
	}
	for k, n := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected count %s in %s = %d (Test data, Build output and prose must not be counted)", k.kind, k.class, n)
		}
	}
}

func TestSuppressionsSayThatConfigFileSuppressionsAreNotCounted(t *testing.T) {
	res := runNativeCheck(t, "quality.suppressions", suppressionsProject)
	for _, l := range res.Limitations {
		if l.ReasonCode == "config_suppressions_not_counted" && l.CheckID != nil && *l.CheckID == "quality.suppressions" {
			return
		}
	}
	t.Errorf("no config_suppressions_not_counted Limitation: %+v", res.Limitations)
}

func TestInventoryHoldsHashesOfTestCodeConfigManifestsAndLockfiles(t *testing.T) {
	res := runNativeCheck(t, "quality.suppressions", suppressionsProject)
	type hash struct{ role, sha string }
	want := map[string]hash{
		"package.json":                   {"manifest", "8128120a0094d54561c0b233bd2e5a704c11144162333a2de88574d53dc4e6af"},
		"package-lock.json":              {"lockfile", "e797d1a339d20beb93ad695d073070ea79226da2cd9d6122d1fcb04645e60ad5"},
		"packages/lib/package.json":      {"manifest", "dc64347675b4e75a927b0cb094e43a40d29b880e9b72f8cdf6bd2840cd2bb9cc"},
		"packages/lib/package-lock.json": {"lockfile", "33c3cbb9fe96c0783e72822561271451fac93c1b1419638bc7e05df3a30b790d"},
		".mocharc.json":                  {"test_config", "e56e400afcfbe193d91051a8eadc8331c7f02f439aa38af15898383822e7a76c"},
		"eslint.config.js":               {"lint_config", "4707cce5979ba8f9408b54b0f076b033f630f1d29476e110730be212556a9cae"},
		"biome.json":                     {"lint_config", "231ea1c84b742103565a4b41810eda5110e51bbf9011f9d2ce898cff8dc0c2ec"},
		".c8rc.json":                     {"coverage_config", "31e4afb363d312a2e8cdac03802f481a59177c1d67d260ef51de5ae095c7494d"},
		"tsconfig.json":                  {"typescript_config", "830deba0a94e3d5dced6e7f8967d8782136ec80d910b2660767f80917521fcb7"},
		"test/app.test.js":               {"test_code", "4db68dbad53e008b40e4b223342a228a18647f8f4b72e48487fb8027b212840f"},
	}
	got := map[string]hash{}
	var order []string
	for _, h := range res.Inventory.FileHashes {
		got[h.Path] = hash{h.Role, h.SHA256}
		order = append(order, h.Path)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("%s = %+v, want %+v", p, got[p], w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("%d hashes, want %d (Test data and Build output files get none): %v", len(got), len(want), order)
	}
	for i := 1; i < len(order); i++ {
		if order[i-1] >= order[i] {
			t.Errorf("hashes are not sorted by path: %v", order)
			break
		}
	}
}

func TestSuppressionsIgnoreDirectivesThatAreNotInComments(t *testing.T) {
	root := t.TempDir()
	writeInventoryFile(t, root, "src/a.js", ""+
		"const s = 'eslint-disable';\n"+
		"const t = \"@ts-ignore\";\n"+
		"// prose that mentions eslint-disable mid-sentence\n"+
		"//eslint-disable-next-line no-undef\n"+
		"/**\n * @ts-expect-error\n */\n"+
		"<!-- eslint-disable -->\n")
	res := runNativeCheck(t, "quality.suppressions", root)
	got := suppressionCounts(res.Inventory)
	if got[suppressionKey{"eslint-disable", "source"}] != 2 || got[suppressionKey{"@ts-expect-error", "source"}] != 1 || got[suppressionKey{"@ts-ignore", "source"}] != 0 {
		t.Errorf("counts = %v", got)
	}
}

func TestSuppressionsApplyToProjectsWithoutAnyJavaScript(t *testing.T) {
	root := t.TempDir()
	writeInventoryFile(t, root, "README.md", "hello\n")
	proj, _ := discovery.Discover(root)
	for _, id := range []string{"quality.size", "quality.suppressions"} {
		got, _ := checks.Implementation(id).Applicability(proj, &proj.Contexts[0])
		if got != resultset.Applicable {
			t.Errorf("%s applicability = %s, want applicable", id, got)
		}
	}
}

func TestNjsscanIgnoreAndNosemgrepCommentsAreSuppressions(t *testing.T) {
	root := t.TempDir()
	writeInventoryFile(t, root, "package.json", `{"name":"p"}`)
	writeInventoryFile(t, root, "src/app.js", ""+
		"// njsscan-ignore: express_open_redirect\n"+
		"res.redirect(req.query.next);\n"+
		"// nosemgrep: prueffactory.eval-non-literal\n"+
		"eval(x); // nosemgrep\n"+
		"const s = 'a nosemgrep in a string is not a comment';\n")
	writeInventoryFile(t, root, "test/app.test.js", "// nosemgrep\nexec(cmd);\n")

	got := suppressionCounts(runNativeCheck(t, "quality.suppressions", root).Inventory)
	want := map[suppressionKey]int{
		{"njsscan-ignore", "source"}: 1,
		{"nosemgrep", "source"}:      2,
		{"nosemgrep", "test_code"}:   1,
	}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%s in %s = %d, want %d", k.kind, k.class, got[k], n)
		}
	}
	if len(got) != len(want) {
		t.Errorf("counts = %v, want only %v", got, want)
	}
}

func writeInventoryFile(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
