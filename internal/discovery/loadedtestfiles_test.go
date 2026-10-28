package discovery_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// The files a runner loads become Test code: a view of the project with those
// files reclassified. The project itself is never changed, because Checks that
// do not wait for the probe read it at the same time.

func loadedProject(t *testing.T) *discovery.Project {
	return project(t, map[string]string{
		"package.json":                  `{"scripts":{"test":"mocha"}}`,
		"src/a.spec.js":                 "",
		"src/setup.js":                  "",
		"src/ab-test.js":                "",
		"test/fixtures/data.js":         "",
		"test/b.js":                     "",
		"dist/c.js":                     "",
		"sub/package.json":              `{}`,
		"sub/src/d.spec.js":             "",
		"sub/src/e.js":                  "",
		"node_modules/dep/index.js":     "",
		"sub/node_modules/dep/index.js": "",
	})
}

func classOf(t *testing.T, p *discovery.Project, rel string) discovery.FileClass {
	t.Helper()
	return fileOf(t, p, rel).Class
}

func pkgClassOf(t *testing.T, p *discovery.Project, pkg, rel string) discovery.FileClass {
	t.Helper()
	for _, pk := range p.Packages {
		if pk.Path != pkg {
			continue
		}
		for _, f := range pk.Files {
			if f.Path == rel {
				return f.Class
			}
		}
	}
	t.Fatalf("package %q has no file %q", pkg, rel)
	return ""
}

func TestFilesTheRunnerLoadsBecomeTestCodeInAViewAndTheProjectStaysAsItWas(t *testing.T) {
	proj := loadedProject(t)
	root := proj.Contexts[1].ID
	loaded := []discovery.TestFile{
		{ContextID: root, Path: "src/a.spec.js", Suite: "scripts.test", Kind: "spec"},
		{ContextID: root, Path: "src/setup.js", Suite: "scripts.test", Kind: "require"},
	}

	view := proj.WithTestFiles(loaded)

	for _, rel := range []string{"src/a.spec.js", "src/setup.js"} {
		if got := classOf(t, view, rel); got != discovery.TestCode {
			t.Errorf("view: %s is %s, want test_code", rel, got)
		}
		if got := pkgClassOf(t, view, ".", rel); got != discovery.TestCode {
			t.Errorf("view package: %s is %s, want test_code", rel, got)
		}
		if got := classOf(t, proj, rel); got != discovery.Source {
			t.Errorf("project: %s is %s, the project itself must not change", rel, got)
		}
		if got := pkgClassOf(t, proj, ".", rel); got != discovery.Source {
			t.Errorf("project package: %s is %s, the project itself must not change", rel, got)
		}
	}
	if got := classOf(t, view, "src/ab-test.js"); got != discovery.Source {
		t.Errorf("a file the runner does not load is %s, want source: no file becomes Test code by its name", got)
	}
}

func TestTheViewsContextsPointToThePackagesOfTheView(t *testing.T) {
	proj := loadedProject(t)
	root := proj.Contexts[1].ID
	view := proj.WithTestFiles([]discovery.TestFile{{ContextID: root, Path: "src/a.spec.js", Suite: "scripts.test", Kind: "spec"}})

	c := view.ContextByID(root)
	if c == nil || c.Package == nil {
		t.Fatalf("context %s = %+v", root, c)
	}
	var found bool
	for _, f := range c.Package.Files {
		if f.Path == "src/a.spec.js" {
			found = f.Class == discovery.TestCode
		}
	}
	if !found {
		t.Error("the view's Context does not see the reclassified file")
	}
	if view.ContextByID(proj.Contexts[0].ID) == nil {
		t.Error("the project Context is missing from the view")
	}
}

func TestOnlySourceCodeInsideThePackageBecomesTestCodeAndTestDataWins(t *testing.T) {
	proj := loadedProject(t)
	root, sub := proj.Contexts[1].ID, proj.Contexts[2].ID
	view := proj.WithTestFiles([]discovery.TestFile{
		{ContextID: root, Path: "test/fixtures/data.js", Suite: "scripts.test", Kind: "spec"}, // Test data stays
		{ContextID: root, Path: "dist/c.js", Suite: "scripts.test", Kind: "require"},          // Build output stays
		{ContextID: root, Path: "sub/src/d.spec.js", Suite: "scripts.test", Kind: "spec"},     // another package's file
		{ContextID: root, Path: "node_modules/dep/index.js", Suite: "scripts.test", Kind: "require"},
		{ContextID: root, Path: "missing.js", Suite: "scripts.test", Kind: "require"},
		{ContextID: sub, Path: "sub/src/e.js", Suite: "scripts.test", Kind: "spec"}, // its own package
	})

	want := map[string]discovery.FileClass{
		"test/fixtures/data.js": discovery.TestData,
		"dist/c.js":             discovery.BuildOutput,
		"sub/src/d.spec.js":     discovery.Source,
		"sub/src/e.js":          discovery.TestCode,
		"src/a.spec.js":         discovery.Source,
		"test/b.js":             discovery.TestCode,
	}
	for rel, class := range want {
		if got := classOf(t, view, rel); got != class {
			t.Errorf("%s is %s, want %s", rel, got, class)
		}
	}
	if len(view.Files) != len(proj.Files) {
		t.Errorf("the view has %d files, the project %d: no file may be added", len(view.Files), len(proj.Files))
	}
}

func TestMovedTestFilesAreTheSourceFilesOfThePackageTheRunnerLoads(t *testing.T) {
	proj := loadedProject(t)
	root := proj.Contexts[1]
	loaded := []discovery.TestFile{
		{ContextID: root.ID, Path: "src/a.spec.js", Suite: "test:unit", Kind: "spec"},
		{ContextID: root.ID, Path: "src/setup.js", Suite: "test:unit", Kind: "require"},
		{ContextID: root.ID, Path: "test/b.js", Suite: "test:unit", Kind: "spec"},             // already Test code
		{ContextID: root.ID, Path: "test/fixtures/data.js", Suite: "test:unit", Kind: "spec"}, // Test data
		{ContextID: root.ID, Path: "sub/src/d.spec.js", Suite: "test:unit", Kind: "spec"},     // another package
		{ContextID: root.ID, Path: "src/a.spec.js", Suite: "test:api", Kind: "spec"},          // the same file in a second suite
		{ContextID: root.ID, Path: "src/a.spec.js", Suite: "test:api", Kind: "spec"},          // listed twice
	}

	moved := proj.MovedTestFiles(root.Package, loaded)

	got := map[string]bool{}
	for _, m := range moved {
		got[m.Suite+"|"+m.Path+"|"+m.Kind] = true
	}
	want := []string{"test:unit|src/a.spec.js|spec", "test:unit|src/setup.js|require", "test:api|src/a.spec.js|spec"}
	if len(moved) != len(want) {
		t.Errorf("moved = %+v, want %v", moved, want)
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("moved lacks %s: %+v", w, moved)
		}
	}
}
