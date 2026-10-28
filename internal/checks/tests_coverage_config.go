package checks

import (
	"encoding/json"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// Where c8 and its output are. Every suite of a package writes its raw V8
// coverage into the same temp directory of one run-owned volume, which outlives
// the containers, and one `c8 report` over that volume gives the Coverage of
// the package. The raw coverage is there however a suite's run ended.
const (
	c8ConfigPath = "/jspf/c8.json"
	c8Bin        = toolvolume.ToolBin + "/c8/bin/c8.js"

	coverageMount = "/jspf-cov"
	coverageTmp   = coverageMount + "/tmp"
	coverageDir   = coverageMount + "/report"
	// suiteReportDir is where the c8 that wraps a suite writes the report of
	// that suite alone, which nobody reads.
	suiteReportDir = coverageMount + "/suite-report"

	coverageSummaryFile = coverageDir + "/coverage-summary.json"
	coverageFilesFile   = coverageDir + "/coverage-final.json"
)

// wrapWithC8 puts the pinned c8 in front of the runner's command. Everything
// after the double dash is the runner's, so none of the project's arguments can
// be read as a c8 option, `--reporter` of Mocha least of all. The project's own
// c8 configuration is never read, because the config file is named explicitly.
func wrapWithC8(cmd []string) []string {
	out := []string{"node", c8Bin, "--config", c8ConfigPath, "--"}
	return append(out, cmd...)
}

// coverageConfig is c8's config document for the report over one package's
// suites: every file below the package root counts (--all), except Test code,
// Test data, Build output, `node_modules` and the folders of nested packages,
// which have their own Context. The reporters are the JSON summary, with a line
// for every file, and the JSON of every file.
//
// The exclusions are globs. A file name is escaped, so that a name such as
// `[id].test.js` or `!x.js` excludes that file and nothing else. All of it is
// in a config file, so no path ever becomes a command line option.
func coverageConfig(proj *discovery.Project, pkg *discovery.Package) []byte {
	return c8Config(proj, pkg, true)
}

// suiteCoverageConfig is the config of the c8 that wraps one suite: it only
// collects. It adds to the raw coverage of the suites before it (clean is off,
// the volume is new for every Run), and it does not look for files the suite
// did not load, because the report does that once for all suites.
func suiteCoverageConfig(proj *discovery.Project, pkg *discovery.Package) []byte {
	return c8Config(proj, pkg, false)
}

func c8Config(proj *discovery.Project, pkg *discovery.Package, report bool) []byte {
	var exclude []string
	seen := map[string]bool{}
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			exclude = append(exclude, p)
		}
	}
	for _, f := range pkg.Files {
		switch f.Class {
		case discovery.TestCode, discovery.TestData, discovery.BuildOutput:
			add(globLiteral(f.PackageRel))
		}
	}
	for _, class := range []discovery.FileClass{discovery.TestCode, discovery.TestData, discovery.BuildOutput} {
		for _, name := range discovery.FolderNames(class) {
			add("**/" + name + "/**")
		}
	}
	add("**/*.min.js")
	add("**/node_modules/**")
	for _, q := range proj.Packages {
		if rel, ok := below(pkg.Path, q.Path); ok {
			add(globLiteral(rel))
		}
	}
	sort.Strings(exclude)

	doc := map[string]any{
		"all":           report,
		"src":           []string{workPath(pkg)},
		"reporter":      []string{"json-summary", "json"},
		"reportsDir":    coverageDir,
		"tempDirectory": coverageTmp,
		"clean":         false,
		"exclude":       exclude,
	}
	if !report {
		doc["reporter"] = []string{"json-summary"}
		doc["reportsDir"] = suiteReportDir
	}
	out, _ := json.Marshal(doc)
	return out
}

// below returns the path of a package relative to another package's folder,
// when it lies below it.
func below(parent, child string) (string, bool) {
	switch {
	case child == parent:
		return "", false
	case parent == ".":
		return child, true
	case strings.HasPrefix(child, parent+"/"):
		return strings.TrimPrefix(child, parent+"/"), true
	}
	return "", false
}

// globLiteral escapes a path for a glob, so that it matches that path only.
func globLiteral(p string) string {
	var b strings.Builder
	for _, r := range path.Clean(p) {
		if strings.ContainsRune(`\*?[]{}()!+@#|`, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
