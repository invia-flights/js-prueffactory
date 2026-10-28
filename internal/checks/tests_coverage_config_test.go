package checks

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// c8 wraps the runner with a config file that we write, never with options
// built from project paths: a path cannot become an option, and a glob
// character in a path cannot widen an exclusion.

type c8Doc struct {
	All        bool     `json:"all"`
	Src        []string `json:"src"`
	Reporter   []string `json:"reporter"`
	ReportsDir string   `json:"reportsDir"`
	TempDir    string   `json:"tempDirectory"`
	Clean      bool     `json:"clean"`
	Exclude    []string `json:"exclude"`
}

func c8DocOf(t *testing.T, proj *discovery.Project, pkg *discovery.Package) c8Doc {
	t.Helper()
	var doc c8Doc
	if err := json.Unmarshal(coverageConfig(proj, pkg), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func c8File(path, rel string, class discovery.FileClass) discovery.File {
	return discovery.File{Path: path, PackageRel: rel, Class: class}
}

func TestC8MeasuresEveryFileOfThePackageRootAndWritesJSONSummaryAndPerFileReports(t *testing.T) {
	pkg := &discovery.Package{Path: "."}
	proj := &discovery.Project{Packages: []*discovery.Package{pkg}}

	doc := c8DocOf(t, proj, pkg)

	if !doc.All || !slices.Equal(doc.Src, []string{"/work"}) {
		t.Errorf("all = %v, src = %q, want --all over the package root /work", doc.All, doc.Src)
	}
	if !slices.Equal(doc.Reporter, []string{"json-summary", "json"}) {
		t.Errorf("reporters = %q", doc.Reporter)
	}
	if doc.ReportsDir != coverageDir || doc.TempDir != coverageTmp || doc.Clean {
		t.Errorf("reports dir %q, temp dir %q, clean %v", doc.ReportsDir, doc.TempDir, doc.Clean)
	}
}

func TestC8ExcludesTestCodeTestDataBuildOutputAndNodeModulesButNotSourceCode(t *testing.T) {
	pkg := &discovery.Package{Path: "packages/api", Files: []discovery.File{
		c8File("packages/api/src/index.js", "src/index.js", discovery.Source),
		c8File("packages/api/test/index.test.js", "test/index.test.js", discovery.TestCode),
		c8File("packages/api/src/helper.spec.js", "src/helper.spec.js", discovery.TestCode),
		c8File("packages/api/test/fixtures/data.js", "test/fixtures/data.js", discovery.TestData),
		c8File("packages/api/dist/index.js", "dist/index.js", discovery.BuildOutput),
	}}
	proj := &discovery.Project{Packages: []*discovery.Package{pkg}}

	doc := c8DocOf(t, proj, pkg)

	if !slices.Equal(doc.Src, []string{"/work/packages/api"}) {
		t.Errorf("src = %q", doc.Src)
	}
	for _, want := range []string{"test/index.test.js", "src/helper.spec.js", "test/fixtures/data.js", "dist/index.js",
		"**/node_modules/**", "**/*.min.js", "**/fixtures/**", "**/__fixtures__/**", "**/testdata/**", "**/__mocks__/**",
		"**/dist/**", "**/build/**", "**/coverage/**", "**/test/**", "**/tests/**", "**/__tests__/**", "**/spec/**"} {
		if !slices.Contains(doc.Exclude, want) {
			t.Errorf("exclude lacks %q: %q", want, doc.Exclude)
		}
	}
	if slices.Contains(doc.Exclude, "src/index.js") {
		t.Errorf("Source code is excluded: %q", doc.Exclude)
	}
}

func TestC8LeavesTheFilesOfNestedPackagesToTheirOwnContext(t *testing.T) {
	root := &discovery.Package{Path: "."}
	child := &discovery.Package{Path: "packages/api"}
	sibling := &discovery.Package{Path: "packages/api-extra"}
	proj := &discovery.Project{Packages: []*discovery.Package{root, child, sibling}}

	if got := c8DocOf(t, proj, root).Exclude; !slices.Contains(got, "packages/api") || !slices.Contains(got, "packages/api-extra") {
		t.Errorf("root exclude = %q, want both nested packages", got)
	}
	if got := c8DocOf(t, proj, child).Exclude; slices.Contains(got, "packages/api") || slices.Contains(got, "packages/api-extra") || slices.Contains(got, "../api-extra") {
		t.Errorf("a package excludes a package that is not below it: %q", got)
	}
}

func TestC8ExclusionsTakeGlobCharactersAndLeadingBangsOfPathsLiterally(t *testing.T) {
	pkg := &discovery.Package{Path: ".", Files: []discovery.File{
		c8File("test/[id].test.js", "test/[id].test.js", discovery.TestCode),
		c8File("test/*.js", "test/*.js", discovery.TestCode),
		c8File("!x.test.js", "!x.test.js", discovery.TestCode),
		c8File("#y.test.js", "#y.test.js", discovery.TestCode),
		c8File("test/{a,b}.js", "test/{a,b}.js", discovery.TestCode),
		c8File("test/a b.js", "test/a b.js", discovery.TestCode),
	}}
	proj := &discovery.Project{Packages: []*discovery.Package{pkg}}

	doc := c8DocOf(t, proj, pkg)

	for _, want := range []string{`test/\[id\].test.js`, `test/\*.js`, `\!x.test.js`, `\#y.test.js`, `test/\{a,b\}.js`, "test/a b.js"} {
		if !slices.Contains(doc.Exclude, want) {
			t.Errorf("exclude lacks %q: %q", want, doc.Exclude)
		}
	}
	for _, bad := range []string{"test/[id].test.js", "test/*.js", "!x.test.js", "#y.test.js", "test/{a,b}.js"} {
		if slices.Contains(doc.Exclude, bad) {
			t.Errorf("exclude holds the unescaped %q, which is a glob or a negation", bad)
		}
	}
}

func TestC8WrapsTheRunnerAfterADoubleDashSoThatItsOwnOptionsAreNeverTheProjects(t *testing.T) {
	got := wrapWithC8([]string{"node", "/work/node_modules/mocha/bin/mocha.js", "--reporter", "/jspf/mocha-reporter.js", "-r", "x"})

	want := []string{"node", "/toolset/node_modules/c8/bin/c8.js", "--config", "/jspf/c8.json", "--",
		"node", "/work/node_modules/mocha/bin/mocha.js", "--reporter", "/jspf/mocha-reporter.js", "-r", "x"}
	if !slices.Equal(got, want) {
		t.Errorf("wrapped = %q, want %q", got, want)
	}
}

func TestTheC8OfASuiteOnlyCollectsIntoTheSharedTempDirectoryAndKeepsWhatTheSuitesBeforeItWrote(t *testing.T) {
	pkg := &discovery.Package{Path: "."}
	proj := &discovery.Project{Packages: []*discovery.Package{pkg}}
	var doc c8Doc
	if err := json.Unmarshal(suiteCoverageConfig(proj, pkg), &doc); err != nil {
		t.Fatal(err)
	}

	if doc.TempDir != coverageTmp || doc.Clean {
		t.Errorf("temp dir %q, clean %v: every suite adds to the same raw coverage", doc.TempDir, doc.Clean)
	}
	if doc.All || doc.ReportsDir == coverageDir {
		t.Errorf("all = %v, reports dir %q: the report over all suites is the only one that counts", doc.All, doc.ReportsDir)
	}
	if want := c8DocOf(t, proj, pkg).Exclude; !slices.Equal(doc.Exclude, want) {
		t.Errorf("exclude = %q, want the same as the report %q", doc.Exclude, want)
	}
}
