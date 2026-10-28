package discovery_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

func testsOf(t *testing.T, files map[string]string, pkgPath string) *discovery.TestSetup {
	t.Helper()
	proj := project(t, files)
	for _, p := range proj.Packages {
		if p.Path == pkgPath {
			return p.Tests
		}
	}
	t.Fatalf("no package %q", pkgPath)
	return nil
}

func TestAPackageRunsMochaFromItsTestScriptOrItsMochaConfig(t *testing.T) {
	cases := []struct {
		name       string
		files      map[string]string
		wantRunner discovery.TestRunner
		wantSource string
		wantNone   bool
	}{
		{"test script", map[string]string{"package.json": `{"scripts":{"test":"mocha --exit"}}`}, discovery.RunnerMocha, "scripts.test", false},
		{"mocharc json without a script", map[string]string{"package.json": `{}`, ".mocharc.json": `{}`}, discovery.RunnerMocha, ".mocharc.json", false},
		{"mocharc yml", map[string]string{"package.json": `{}`, ".mocharc.yml": "exit: true\n"}, discovery.RunnerMocha, ".mocharc.yml", false},
		{"mocharc cjs", map[string]string{"package.json": `{}`, ".mocharc.cjs": "module.exports = {};\n"}, discovery.RunnerMocha, ".mocharc.cjs", false},
		{"the script wins over the config", map[string]string{"package.json": `{"scripts":{"test":"node --test"}}`, ".mocharc.json": `{}`}, discovery.RunnerNodeTest, "scripts.test", false},
		{"npm init placeholder with a config", map[string]string{
			"package.json":  `{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}`,
			".mocharc.json": `{}`}, discovery.RunnerMocha, ".mocharc.json", false},
		{"npm init placeholder", map[string]string{"package.json": `{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}`}, "", "", true},
		{"no test script", map[string]string{"package.json": `{"scripts":{"start":"node ."}}`}, "", "", true},
		{"a nested config does not count", map[string]string{"package.json": `{}`, "test/.mocharc.json": `{}`}, "", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := testsOf(t, c.files, ".")
			if c.wantNone {
				if got != nil {
					t.Fatalf("tests = %+v, want none", got)
				}
				return
			}
			if got == nil || got.Unsupported != nil || len(got.Suites) != 1 ||
				got.Suites[0].Runner != c.wantRunner || got.Suites[0].Origin != c.wantSource {
				t.Fatalf("tests = %+v, want one %s suite from %s", got, c.wantRunner, c.wantSource)
			}
		})
	}
}

func TestAPackageWithAnUnsupportedRunnerSaysWhy(t *testing.T) {
	got := testsOf(t, map[string]string{"package.json": `{"scripts":{"test":"jest --ci"}}`}, ".")
	if got == nil || got.Unsupported == nil || got.Unsupported.Code != "test_runner_unsupported" ||
		!strings.Contains(got.Unsupported.Reason, "jest --ci") {
		t.Fatalf("tests = %+v", got)
	}
}

func TestEachPackageReadsItsOwnTestScript(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json":     `{"scripts":{"test":"mocha"}}`,
		"sub/package.json": `{"scripts":{"test":"node --test"}}`,
	})
	got := map[string]discovery.TestRunner{}
	for _, p := range proj.Packages {
		got[p.Path] = p.Tests.Suites[0].Runner
	}
	if got["."] != discovery.RunnerMocha || got["sub"] != discovery.RunnerNodeTest {
		t.Errorf("runners = %v", got)
	}
}

func assertClasses(t *testing.T, proj *discovery.Project, want map[string]discovery.FileClass) {
	t.Helper()
	for path, class := range want {
		if got := fileOf(t, proj, path).Class; got != class {
			t.Errorf("%s: class = %s, want %s", path, got, class)
		}
	}
	// The package's own copy of the file list agrees with the project's.
	for _, p := range proj.Packages {
		for _, f := range p.Files {
			if want[f.Path] != "" && f.Class != want[f.Path] {
				t.Errorf("package copy of %s: class = %s, want %s", f.Path, f.Class, want[f.Path])
			}
		}
	}
}

func TestFilesTheRunnerLoadsAreTestCode(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json": `{"scripts":{"test":"mocha 'checks/api' 'checks/unit/**/*.js' --require ./setup/globals.js --file lib/boot.js --config ci/mocha.js"}}`,
		// loaded: a directory (not recursive), a glob, --require, --file
		"checks/api/a.js": "", "checks/api/deep/b.js": "", "checks/api/readme.md": "",
		"checks/unit/x/c.js": "", "checks/unit/d.js": "",
		"setup/globals.js": "", "lib/boot.js": "",
		// not loaded
		"src/app.js": "", "ci/mocha.js": "", "checks/other.js": "",
		// Test data wins over Test code
		"checks/unit/fixtures/e.js": "",
	})
	assertClasses(t, proj, map[string]discovery.FileClass{
		"checks/api/a.js": discovery.TestCode, "checks/api/deep/b.js": discovery.Source, "checks/api/readme.md": discovery.Source,
		"checks/unit/x/c.js": discovery.TestCode, "checks/unit/d.js": discovery.TestCode,
		"setup/globals.js": discovery.TestCode, "lib/boot.js": discovery.TestCode,
		"src/app.js": discovery.Source, "ci/mocha.js": discovery.Source, "checks/other.js": discovery.Source,
		"checks/unit/fixtures/e.js": discovery.TestData,
	})
}

func TestMochaConfigFilesNameTheTestFilesToo(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json":       `{}`,
		".mocharc.yaml":      "spec:\n  - 'suites/**/*.spec.js'\nrequire: helpers/setup.js\n",
		"suites/a/b.spec.js": "", "suites/a/not-a-spec.js": "", "helpers/setup.js": "",
	})
	assertClasses(t, proj, map[string]discovery.FileClass{
		"suites/a/b.spec.js": discovery.TestCode, "suites/a/not-a-spec.js": discovery.Source, "helpers/setup.js": discovery.TestCode,
	})
}

func TestRecursiveDirectoriesAndBracesAreFollowed(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json": `{"scripts":{"test":"mocha --recursive e2e 'unit/**/*.{js,mjs}'"}}`,
		"e2e/a.js":     "", "e2e/deep/b.mjs": "", "e2e/deep/c.txt": "",
		"unit/x/y.mjs": "", "unit/z.js": "", "unit/z.cjs": "",
	})
	assertClasses(t, proj, map[string]discovery.FileClass{
		"e2e/a.js": discovery.TestCode, "e2e/deep/b.mjs": discovery.TestCode, "e2e/deep/c.txt": discovery.Source,
		"unit/x/y.mjs": discovery.TestCode, "unit/z.js": discovery.TestCode, "unit/z.cjs": discovery.Source,
	})
}

func TestEveryChainSuiteNamesItsOwnTestFiles(t *testing.T) {
	proj := project(t, map[string]string{
		"package.json":     `{"scripts":{"test":"npm run unit && npm run api","unit":"mocha checks/unit --require ./setup/unit.js","api":"mocha 'checks/api/**/*.js'"}}`,
		"checks/unit/a.js": "", "setup/unit.js": "", "checks/api/b.js": "", "checks/api/deep/c.js": "",
		"src/app.js": "",
	})
	assertClasses(t, proj, map[string]discovery.FileClass{
		"checks/unit/a.js": discovery.TestCode, "setup/unit.js": discovery.TestCode,
		"checks/api/b.js": discovery.TestCode, "checks/api/deep/c.js": discovery.TestCode,
		"src/app.js": discovery.Source,
	})
}
