package checks

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Recorded from Knip 6.43.0 (`knip --reporter json --no-exit-code`) on the
// mocha-config-unused testdata project: the Mocha configs under test/config
// give require paths that are relative to the package root, which Knip reads
// relative to the config file.
const knipMochaOutput = `{"issues":[
 {"file":"src/unused.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"src/unused.js"}]},
 {"file":"test/helpers/only-setup.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/helpers/only-setup.js"}]},
 {"file":"test/setup/api.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/api.js"}]},
 {"file":"test/setup/base.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/base.js"}]},
 {"file":"test/setup/unit.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/unit.js"}]},
 {"file":"package.json","dependencies":[{"name":"is-odd","line":18,"col":6,"pos":818}],"devDependencies":[{"name":"c8","line":13,"col":6,"pos":713},{"name":"mocha-multi-reporters","line":15,"col":6,"pos":756}],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[]},
 {"file":"test/config/mocha-api.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[{"name":"test/setup/base.js"},{"name":"test/setup/api.js"}],"exports":[],"types":[],"files":[]},
 {"file":"test/config/mocha-unit.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[{"name":"test/setup/base.js"},{"name":"test/setup/unit.js"}],"exports":[],"types":[],"files":[]}
]}`

// mochaConfigUnused returns the package Context of the mocha-config-unused
// testdata project, copied so that a test may add files.
func mochaConfigUnused(t *testing.T, edit func(dir string)) (*discovery.Project, *discovery.Context, string) {
	t.Helper()
	src, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "mocha-config-unused"))
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "mocha-config-unused")
	err = filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dir, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	if edit != nil {
		edit(dir)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := range proj.Contexts {
		if proj.Contexts[i].Package != nil {
			return proj, &proj.Contexts[i], dir
		}
	}
	t.Fatal("no package Context")
	return nil, nil, ""
}

func mochaKnipInput(t *testing.T, edit func(dir string)) *Input {
	t.Helper()
	proj, c, dir := mochaConfigUnused(t, edit)
	return &Input{Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir}
}

func foundNames(res *Result) []string {
	var out []string
	for _, f := range res.Findings {
		out = append(out, *f.RuleID+" "+f.Locations[0].Path+" "+f.Evidence[0].Text)
	}
	sort.Strings(out)
	return out
}

func TestKnipFindingsOfAMochaConfigAreCorrected(t *testing.T) {
	in := mochaKnipInput(t, nil)
	res := interpretKnip(in, []byte(knipMochaOutput))
	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	// What Knip reports falsely is gone. What is really unused stays: the
	// file nothing loads, and the dependency nothing uses. The files that only
	// the setup files import are not reported by a first run, either: the
	// second run, with the setup files as entry files, decides that.
	got := foundNames(res)
	for _, f := range got {
		if strings.HasPrefix(f, "unresolved-import") {
			t.Errorf("a false unresolved import is left: %s", f)
		}
		if strings.Contains(f, "mocha-multi-reporters") || strings.Contains(f, " c8") {
			t.Errorf("a dependency that is used is reported: %s", f)
		}
	}
	for _, want := range []string{
		"unused-dependency package.json is-odd",
		"unused-file src/unused.js src/unused.js",
	} {
		if !contains(got, want) {
			t.Errorf("findings = %v, want %q", got, want)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestMochaLoadedFilesAreTheRelativeRequiresThatExistFromThePackageRoot(t *testing.T) {
	in := mochaKnipInput(t, nil)
	_, loaded, err := in.correctKnip([]byte(knipMochaOutput))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"test/setup/api.js", "test/setup/base.js", "test/setup/unit.js"}
	if !reflect.DeepEqual(loaded, want) {
		t.Errorf("loaded = %v, want %v", loaded, want)
	}
}

// A config that names a setup file through a helper (`file: files.map(...)`)
// gives Knip no unresolved import to learn it from. The test file probe asked
// Mocha itself, so what it found under `file`, `require` or `import` is loaded
// by Mocha as well, and an unused-file Finding for it is false.
// A Suite whose command names a folder (`mocha test/modules`, with `recursive`
// in the config) loads specs that Knip never learns of, and it reports every one
// of them, and the sources only they import, as unused. The spec files the probe
// found and Knip reported are loaded by Mocha, so they become entry files of the
// second run. A spec that Knip did not report needs no entry.
func TestSpecFilesThatKnipReportsAsUnusedAreMochaLoadedAndBecomeEntriesOfTheSecondRun(t *testing.T) {
	in := mochaKnipInput(t, func(dir string) {
		if err := os.MkdirAll(filepath.Join(dir, "test", "modules", "deep"), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"test/modules/deep/a.test.js", "test/modules/deep/b.test.js"} {
			if err := os.WriteFile(filepath.Join(dir, f), []byte("it('x', () => {});\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	})
	in.Shared = NewShared()
	in.Shared.Put(testFilesKey(in.Context.ID), &testFilesProbe{Files: []discovery.TestFile{
		{ContextID: in.Context.ID, Path: "test/modules/deep/a.test.js", Suite: "scripts.test", Kind: "spec"},
		{ContextID: in.Context.ID, Path: "test/modules/deep/b.test.js", Suite: "scripts.test", Kind: "spec"},
	}})
	const report = `{"issues":[{"file":"test/modules/deep/a.test.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/modules/deep/a.test.js"}]},
 {"file":"src/unused.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"src/unused.js"}]}]}`

	_, loaded, err := in.correctKnip([]byte(report))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"test/modules/deep/a.test.js"}; !reflect.DeepEqual(loaded, want) {
		t.Errorf("loaded = %v, want %v (b.test.js is no entry: Knip did not report it)", loaded, want)
	}
	cfg, ok := in.knipSecondRunConfig([]byte(report))
	if !ok || !strings.Contains(string(cfg), `"test/modules/deep/a.test.js"`) {
		t.Errorf("second run = %v with config %s, want a.test.js as an entry file", ok, cfg)
	}
	// Whatever the second run still reports for a loaded spec is dropped.
	res := interpretKnip(in, []byte(report))
	if got := foundNames(res); !reflect.DeepEqual(got, []string{"unused-file src/unused.js src/unused.js"}) {
		t.Errorf("findings = %v, want only src/unused.js", got)
	}
}

func TestFilesTheProbeFoundUnderFileRequireAndImportAreMochaLoadedToo(t *testing.T) {
	in := mochaKnipInput(t, func(dir string) {
		if err := os.WriteFile(filepath.Join(dir, "test", "setup", "late.mjs"), []byte("export {};\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	in.Shared = NewShared()
	in.Shared.Put(testFilesKey(in.Context.ID), &testFilesProbe{Files: []discovery.TestFile{
		{ContextID: in.Context.ID, Path: "test/setup/late.mjs", Suite: "test:api", Kind: "file"},
		{ContextID: in.Context.ID, Path: "test/api/a.test.js", Suite: "test:api", Kind: "spec"},
		{ContextID: in.Context.ID, Path: "test/setup/missing.js", Suite: "test:api", Kind: "require"},
	}})
	const lateOnly = `{"issues":[{"file":"test/setup/late.mjs","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/late.mjs"}]}]}`

	_, loaded, err := in.correctKnip([]byte(lateOnly))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"test/setup/late.mjs"}; !reflect.DeepEqual(loaded, want) {
		t.Errorf("loaded = %v, want %v (specs and files that do not exist are no entries)", loaded, want)
	}
	res := interpretKnip(in, []byte(lateOnly))
	if got := foundNames(res); len(got) != 0 {
		t.Errorf("findings = %v, want none", got)
	}
}
