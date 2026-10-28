package checks

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// writeTree writes a project folder and discovers it.
func writeTree(t *testing.T, files map[string]string) (*discovery.Project, string) {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	return proj, dir
}

func eslintProblems(t *testing.T) (*discovery.Project, string) {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "eslint-problems"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	return proj, dir
}

func packageContext(t *testing.T, proj *discovery.Project, path string) *discovery.Context {
	t.Helper()
	for i := range proj.Contexts {
		if proj.Contexts[i].Package != nil && proj.Contexts[i].Package.Path == path {
			return &proj.Contexts[i]
		}
	}
	t.Fatalf("no package Context at %s", path)
	return nil
}

func TestLintCorrectnessIsImplementedPerPackageAndNeverFiresGates(t *testing.T) {
	entry, ok := Lookup("lint.correctness")
	if !ok || entry.Status != Implemented || entry.Scope != PerPackage {
		t.Fatalf("lint.correctness = %+v, want implemented per package", entry)
	}
	if entry.CanFireGates {
		t.Error("lint.correctness reports warnings, never Gates")
	}
}

func TestLintCorrectnessAppliesToPackagesWithJavaScriptOutsideTestDataAndBuildOutput(t *testing.T) {
	proj, _ := eslintProblems(t)
	impl := Implementation("lint.correctness")

	got, reason := impl.Applicability(proj, packageContext(t, proj, "."))
	if got != resultset.Applicable {
		t.Fatalf("applicability = %v (%s)", got, reason)
	}
	if got, _ := impl.Applicability(proj, &proj.Contexts[0]); got != resultset.NotApplicable {
		t.Errorf("the project Context holds no package to lint, got %v", got)
	}

	bare, _ := writeTree(t, map[string]string{
		"package.json":       `{"name":"x"}`,
		"test/fixtures/a.js": "debugger;\n",
		"dist/bundle.js":     "debugger;\n",
		"src/app.ts":         "export {};\n",
		"README.md":          "# x\n",
	})
	got, reason = impl.Applicability(bare, packageContext(t, bare, "."))
	if got != resultset.NotApplicable || reason == "" {
		t.Errorf("a package with only Test data, Build output and TypeScript = %v (%q), want not_applicable with a reason", got, reason)
	}
}

func TestOnlyJavaScriptOfSourceAndTestCodeIsLintedWithTheSourceTypeOfItsPackage(t *testing.T) {
	cases := []struct {
		name        string
		packageType string
		wantJS      string
	}{
		{"no type field", "", "commonjs"},
		{"commonjs", `,"type":"commonjs"`, "commonjs"},
		{"module", `,"type":"module"`, "module"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj, dir := writeTree(t, map[string]string{
				"package.json":       `{"name":"x"` + c.packageType + `}`,
				"src/a.js":           "1;\n",
				"src/b.mjs":          "1;\n",
				"src/c.cjs":          "1;\n",
				"src/d.ts":           "1;\n",
				"src/e.jsx":          "1;\n",
				"test/a.test.js":     "1;\n",
				"test/fixtures/f.js": "1;\n",
				"dist/g.js":          "1;\n",
				"src/h.min.js":       "1;\n",
			})
			in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

			files := eslintTargets(in)

			got := map[string]string{}
			for _, f := range files {
				got[f.Path] = f.SourceType
			}
			want := map[string]string{
				"src/a.js": c.wantJS, "src/b.mjs": "module", "src/c.cjs": "commonjs", "test/a.test.js": c.wantJS,
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("targets = %v, want %v", got, want)
			}
		})
	}
}

func TestTargetsOfANestedPackageAreRelativeToItsFolderAndLeaveOutTheOuterPackage(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json":                `{"name":"root"}`,
		"src/root.js":                 "1;\n",
		"packages/inner/package.json": `{"name":"inner","type":"module"}`,
		"packages/inner/src/in.js":    "1;\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "packages/inner"), SnapshotDir: dir}

	files := eslintTargets(in)
	if len(files) != 1 || files[0].Path != "src/in.js" || files[0].SourceType != "module" {
		t.Errorf("targets = %+v, want only src/in.js as a module", files)
	}
}

func TestSymbolicLinksAreNeverGivenToESLint(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json": `{"name":"x"}`,
		"src/real.js":  "1;\n",
	})
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "src", "link.js")); err != nil {
		t.Skip("cannot create a symbolic link here")
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	files := eslintTargets(in)
	var paths []string
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	sort.Strings(paths)
	if !reflect.DeepEqual(paths, []string{"src/real.js"}) {
		t.Errorf("targets = %v, want the real file only", paths)
	}
}

func TestMochaGlobalsApplyToTestCodeOfPackagesThatNameMocha(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		mocha bool
	}{
		{"test script", map[string]string{"package.json": `{"scripts":{"test":"mocha --recursive"}}`}, true},
		{"test script the tool does not parse, mocha a devDependency", map[string]string{"package.json": `{"scripts":{"test":"NODE_ENV=test npx mocha"},"devDependencies":{"mocha":"*"}}`}, true},
		{"mocharc json", map[string]string{"package.json": `{"scripts":{"test":"npm run unit"}}`, ".mocharc.json": "{}"}, true},
		{"mocharc cjs", map[string]string{"package.json": `{}`, ".mocharc.cjs": "module.exports = {};"}, true},
		{"test script delegating through npm run, mocha a devDependency", map[string]string{"package.json": `{"scripts":{"test":"npm run test:unit && npm run test:api","test:unit":"mocha --config test/config/mocha-unit.js"},"devDependencies":{"mocha":"^10.0.0"}}`}, true},
		{"mocha a dependency", map[string]string{"package.json": `{"scripts":{"test":"npm run unit && npm run api"},"dependencies":{"mocha":"^10.0.0"}}`}, true},
		{"mocha only a peer dependency", map[string]string{"package.json": `{"peerDependencies":{"mocha":"*"}}`}, false},
		{"mocha-like dependency", map[string]string{"package.json": `{"devDependencies":{"mocha-multi-reporters":"^1.0.0"}}`}, false},
		{"node test runner", map[string]string{"package.json": `{"scripts":{"test":"node --test"}}`}, false},
		{"a word that only contains mocha", map[string]string{"package.json": `{"scripts":{"test":"echo mochalike"}}`}, false},
		{"mocha in another script", map[string]string{"package.json": `{"scripts":{"test":"jest","lint":"mocha-lint"}}`}, false},
		{"nothing", map[string]string{"package.json": `{}`}, false},
		{"broken manifest", map[string]string{"package.json": `{`}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			files := map[string]string{"test/a.test.js": "1;\n", "src/a.js": "1;\n"}
			for k, v := range c.files {
				files[k] = v
			}
			proj, dir := writeTree(t, files)
			in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

			input, err := eslintHelperInput(in, nil)
			if err != nil {
				t.Fatal(err)
			}

			if input.Mocha != c.mocha {
				t.Errorf("mocha = %v, want %v", input.Mocha, c.mocha)
			}
			if !reflect.DeepEqual(input.TestFiles, []string{"test/a.test.js"}) {
				t.Errorf("test files = %v, want only Test code", input.TestFiles)
			}
		})
	}
}

func TestAnOversizedFileIsNotGivenToESLintButIsListedAsSkipped(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json": `{"name":"x"}`,
		"src/small.js": "1;\n",
	})
	big := make([]byte, eslintMaxFileBytes+1)
	for i := range big {
		big[i] = ' '
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "big.js"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	input, err := eslintHelperInput(in, nil)
	if err != nil {
		t.Fatal(err)
	}

	if len(input.Files) != 1 || input.Files[0].Path != "src/small.js" {
		t.Errorf("files = %+v, want only the small one", input.Files)
	}
	if !reflect.DeepEqual(input.Oversized, []string{"src/big.js"}) {
		t.Errorf("oversized = %v", input.Oversized)
	}
}
