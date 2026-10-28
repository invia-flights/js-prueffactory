package discovery_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// project writes files (path -> content) below a new temp folder and discovers it.
func project(t *testing.T, files map[string]string) *discovery.Project {
	t.Helper()
	root := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := discovery.Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	return p
}

func fileOf(t *testing.T, p *discovery.Project, path string) discovery.File {
	t.Helper()
	for _, f := range p.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("%s not discovered; have %v", path, p.Files)
	return discovery.File{}
}

func TestFileClasses(t *testing.T) {
	files := map[string]string{"package.json": "{}"}
	want := map[string]discovery.FileClass{
		"src/app.js":                    discovery.Source,
		"index.js":                      discovery.Source,
		"test/a.test.js":                discovery.TestCode,
		"tests/unit/b.js":               discovery.TestCode,
		"src/__tests__/c.js":            discovery.TestCode,
		"spec/d.js":                     discovery.TestCode,
		"test/fixtures/data.js":         discovery.TestData, // Test data wins over Test code
		"src/__fixtures__/x.json":       discovery.TestData,
		"testdata/y.js":                 discovery.TestData,
		"src/__mocks__/m.js":            discovery.TestData,
		"dist/bundle.js":                discovery.BuildOutput,
		"build/out.js":                  discovery.BuildOutput,
		"coverage/lcov-report/x.js":     discovery.BuildOutput,
		"public/vendor.min.js":          discovery.BuildOutput,
		"README.md":                     discovery.Source,
		"scripts/docker/Dockerfile":     discovery.Source,
		"tester/not-a-test-folder.js":   discovery.Source,
		"src/fixtures-like/not-data.js": discovery.Source,
	}
	for p := range want {
		files[p] = ""
	}
	proj := project(t, files)
	for path, class := range want {
		if got := fileOf(t, proj, path).Class; got != class {
			t.Errorf("%s: class %q, want %q", path, got, class)
		}
	}
}

func TestPackagesAndContextIDs(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json":                   `{"name":"root"}`,
		"src/index.js":                   "",
		"ci/complexity/package.json":     `{"name":"complexity"}`,
		"ci/complexity/run.js":           "",
		"node_modules/dep/package.json":  `{}`,
		"test/fixtures/pkg/package.json": `{}`,
		"dist/package.json":              `{}`,
		"tools/standalone.js":            "",
	})

	var paths []string
	for _, p := range proj.Packages {
		paths = append(paths, p.Path)
	}
	if want := []string{".", "ci/complexity"}; !slices.Equal(paths, want) {
		t.Fatalf("packages = %v, want %v (not node_modules, Test data or Build output)", paths, want)
	}

	// The project Context comes first, then packages in path order.
	var ids []string
	for _, c := range proj.Contexts {
		ids = append(ids, c.ID+":"+c.Kind+":"+c.Path)
	}
	want := []string{"C-0001:project:.", "C-0002:package:.", "C-0003:package:ci/complexity"}
	if !slices.Equal(ids, want) {
		t.Fatalf("contexts = %v, want %v", ids, want)
	}

	// A file belongs to its nearest package, files outside every package to the project.
	if got := fileOf(t, proj, "ci/complexity/run.js").ContextID; got != "C-0003" {
		t.Errorf("ci/complexity/run.js in %s, want C-0003", got)
	}
	if got := fileOf(t, proj, "src/index.js").ContextID; got != "C-0002" {
		t.Errorf("src/index.js in %s, want C-0002", got)
	}
}

func TestFilesOutsideEveryPackageBelongToTheProjectContext(t *testing.T) {
	proj := project(t, map[string]string{
		"app/package.json": `{}`,
		"app/a.js":         "",
		"scripts/tool.js":  "",
	})
	if got := fileOf(t, proj, "scripts/tool.js").ContextID; got != "C-0001" {
		t.Errorf("scripts/tool.js in %s, want the project Context C-0001", got)
	}
}

func TestPackageContextRecordsTheNodeImage(t *testing.T) {
	proj := project(t, map[string]string{"package.json": `{}`})
	var pkg discovery.Context
	for _, c := range proj.Contexts {
		if c.Kind == "package" {
			pkg = c
		}
	}
	n := pkg.Node
	if n == nil {
		t.Fatal("package Context has no Node runtime")
	}
	if n.Version != "24" || n.Source != "default" || n.Variant != "debian" {
		t.Errorf("node = %+v, want default 24 on debian", n)
	}
	if !strings.HasPrefix(n.ImageDigest, "sha256:") || !strings.Contains(n.Image, "@sha256:") {
		t.Errorf("image must be pinned by digest: %+v", n)
	}
	if pkg.Limits.CPUs != 2 || pkg.Limits.MemoryMB != 4096 {
		t.Errorf("limits = %+v", pkg.Limits)
	}
}

func TestBuildStepDetection(t *testing.T) {
	cases := map[string]map[string]string{
		"babel config":      {"package.json": `{}`, ".babelrc": "{}", "a.js": ""},
		"babel in manifest": {"package.json": `{"babel":{"presets":[]}}`, "a.js": ""},
		"babel.config":      {"package.json": `{}`, "babel.config.js": "", "a.js": ""},
		"webpack":           {"package.json": `{}`, "webpack.config.js": "", "a.js": ""},
		"rollup":            {"package.json": `{}`, "rollup.config.mjs": "", "a.js": ""},
		"vite":              {"package.json": `{}`, "vite.config.js": "", "a.js": ""},
		"tsconfig with ts and outDir": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`, "src/a.ts": ""},
		"tsconfig with ts and rootDir": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"rootDir":"src"}}`, "src/a.ts": ""},
		"tsconfig with ts and declaration": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"declaration":true}}`, "src/a.mts": ""},
		"tsconfig with comments and trailing commas": {
			"package.json": `{}`, "tsconfig.json": "{\n // emit\n \"compilerOptions\": {\"outDir\": \"lib\",},\n}\n", "a.cts": ""},
		"emit signal from a relative extends": {
			"package.json": `{}`, "tsconfig.json": `{"extends":"./tsconfig.base.json"}`,
			"tsconfig.base.json": `{"compilerOptions":{"outDir":"dist"}}`, "a.ts": ""},
		"tsconfig with ts and a tsc build script": {
			"package.json": `{"scripts":{"build":"tsc -p ."}}`, "tsconfig.json": "{}", "a.ts": ""},
		"tsconfig with ts and a bundler script": {
			"package.json": `{"scripts":{"prepare":"npm run clean && tsup src/index.ts"}}`, "tsconfig.json": "{}", "a.ts": ""},
	}
	for name, files := range cases {
		proj := project(t, files)
		if got := proj.Packages[0].BuildStepReason; got == "" {
			t.Errorf("%s: expected a build-step reason", name)
		}
	}
	for name, files := range map[string]map[string]string{
		"plain":                    {"package.json": `{}`, "a.js": ""},
		"tsconfig only for editor": {"package.json": `{}`, "tsconfig.json": "{}", "a.js": ""},
		"emit settings without TypeScript sources": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`, "a.js": "", "a.d.ts": ""},
		"editor tsconfig next to a few TypeScript files": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"checkJs":true,"allowJs":true,"noEmit":true,"strict":true}}`,
			"a.js": "", "src/b.ts": "", "src/c.tsx": ""},
		"noEmit wins over an outDir": {
			"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"outDir":"dist","noEmit":true}}`, "src/a.ts": ""},
		"type check scripts only": {
			"package.json":  `{"scripts":{"lint":"tsc --noEmit","typecheck":"tsc -p . --noEmit","test":"mocha"}}`,
			"tsconfig.json": "{}", "src/a.ts": ""},
		"a package that only names tsc in a word": {
			"package.json": `{"scripts":{"build":"echo atsc ctsc"}}`, "tsconfig.json": "{}", "src/a.ts": ""},
		"an unreadable extends is no signal": {
			"package.json": `{}`, "tsconfig.json": `{"extends":"@tsconfig/node20/tsconfig.json"}`, "src/a.ts": ""},
	} {
		if got := project(t, files).Packages[0].BuildStepReason; got != "" {
			t.Errorf("%s: unexpected build-step reason %q", name, got)
		}
	}
}

func TestBuildStepRulesNeverReadThroughASymlinkOutOfTheProjectOrAHugeFile(t *testing.T) {
	outside := t.TempDir()
	for name, content := range map[string]string{
		"tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`,
		"package.json":  `{"scripts":{"build":"tsc"},"babel":{}}`,
	} {
		if err := os.WriteFile(filepath.Join(outside, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	huge := `{"compilerOptions":{"outDir":"dist"},"x":"` + strings.Repeat("a", 2<<20) + `"}`

	cases := map[string]func(t *testing.T, root string){
		"a symlinked folder holding the extended config": func(t *testing.T, root string) {
			must(t, os.Symlink(outside, filepath.Join(root, "shared")))
			must(t, os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{"extends":"./shared/tsconfig.json"}`), 0o644))
		},
		"a symlinked tsconfig.json": func(t *testing.T, root string) {
			must(t, os.Symlink(filepath.Join(outside, "tsconfig.json"), filepath.Join(root, "tsconfig.json")))
		},
		"a symlinked package.json": func(t *testing.T, root string) {
			must(t, os.Remove(filepath.Join(root, "package.json")))
			must(t, os.Symlink(filepath.Join(outside, "package.json"), filepath.Join(root, "package.json")))
			must(t, os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{}`), 0o644))
		},
		"a huge tsconfig.json": func(t *testing.T, root string) {
			must(t, os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(huge), 0o644))
		},
		"a huge package.json": func(t *testing.T, root string) {
			must(t, os.WriteFile(filepath.Join(root, "tsconfig.json"), []byte(`{}`), 0o644))
			must(t, os.WriteFile(filepath.Join(root, "package.json"),
				[]byte(`{"x":"`+strings.Repeat("a", 2<<20)+`","scripts":{"build":"tsc"}}`), 0o644))
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			must(t, os.MkdirAll(filepath.Join(root, "src"), 0o755))
			must(t, os.WriteFile(filepath.Join(root, "src", "a.ts"), nil, 0o644))
			if _, err := os.Lstat(filepath.Join(root, "package.json")); err != nil {
				must(t, os.WriteFile(filepath.Join(root, "package.json"), []byte(`{}`), 0o644))
			}
			setup(t, root)
			p, err := discovery.Discover(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(p.Packages) != 1 {
				t.Fatalf("packages = %d, want the one package", len(p.Packages))
			}
			for _, pkg := range p.Packages {
				if pkg.BuildStepReason != "" {
					t.Errorf("build step reason = %q, want none: what lies outside the project or is huge is not read", pkg.BuildStepReason)
				}
			}
		})
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuildStepReasonNamesTheEmitSignal(t *testing.T) {
	got := project(t, map[string]string{
		"package.json": `{}`, "tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`, "a.ts": "",
	}).Packages[0].BuildStepReason
	if !strings.Contains(got, "tsconfig.json") || !strings.Contains(got, "outDir") {
		t.Errorf("reason = %q, want it to name tsconfig.json and outDir", got)
	}
	got = project(t, map[string]string{
		"package.json": `{"scripts":{"build":"tsc"}}`, "tsconfig.json": "{}", "a.ts": "",
	}).Packages[0].BuildStepReason
	if !strings.Contains(got, "scripts.build") {
		t.Errorf("reason = %q, want it to name scripts.build", got)
	}
}

func TestDiscoverNeverReadsOutsideTheRoot(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "package.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(proj.Packages) != 1 {
		t.Fatalf("followed a symlink out of the root: %d packages", len(proj.Packages))
	}
}
