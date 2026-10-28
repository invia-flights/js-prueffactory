package checks

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The test file probe. Folder names and the static reading of Mocha's JSON and
// YAML configs classify test files during discovery, without running project
// code. They miss co-located specs and configs written in JavaScript, so
// right after a package's install the probe asks the project's own Mocha which
// files each of the package's suites loads, and the files that are Source code
// by their place become Test code (discovery.Project.WithTestFiles). It is
// part of package.install, in the package's container, because the installed
// Mocha is the only one that can answer.
//
// The Checks that read File classes wait for it (FileClassReader) and read the
// Project it leaves for them (Input.withProbedTestFiles). A probe that fails
// leaves the static classes and a Limitation.

//go:embed js/mocha-probe.js
var mochaProbeScript []byte

const (
	mochaProbePath = "/jspf/mocha-probe.js"
	// probeMarker starts the one line the probe script answers with.
	probeMarker = "@@JSPF-PROBE@@"
	// probeTimeout is how long the probe of one suite may take.
	probeTimeout = 30 * time.Second
	// testFilesNotResolved is the reason code of a suite whose probe failed.
	testFilesNotResolved = "test_files_not_resolved"
)

// FileClassReader is implemented by Checks that read the File class of files:
// the engine runs them after the probe of the packages whose files they examine
// (all packages for a project Check), and gives them the Project with the files
// the test runners load as Test code. Checks that do not implement it neither
// wait nor see the moved files.
type FileClassReader interface {
	ReadsFileClasses() bool
}

// HasTestFileProbe says whether package.install probes the package's suites:
// the package has tests this release runs, and an image to run them in.
func HasTestFileProbe(c *discovery.Context) bool {
	return c.Package != nil && c.Node != nil && unsupportedTests(c.Package) == nil
}

// testFilesProbe is what the probe of one package found, for the Checks that
// wait for it.
type testFilesProbe struct {
	Files []discovery.TestFile
}

func testFilesKey(contextID string) string { return "test-files/" + contextID }

// ProbedTestFiles returns the files the probe of the package in the Context
// found, or nil when it found none or did not run.
func ProbedTestFiles(s *Shared, contextID string) []discovery.TestFile {
	if s == nil {
		return nil
	}
	v, ok := s.Get(testFilesKey(contextID))
	if !ok {
		return nil
	}
	return v.(*testFilesProbe).Files
}

// ProjectWithProbedTestFiles is the Project a Check that reads File classes
// sees: the discovered one, with the files of the given packages' probes as
// Test code. The Context is the same Context in that Project.
func ProjectWithProbedTestFiles(proj *discovery.Project, c *discovery.Context, s *Shared, contextIDs []string) (*discovery.Project, *discovery.Context) {
	var files []discovery.TestFile
	for _, id := range contextIDs {
		files = append(files, ProbedTestFiles(s, id)...)
	}
	view := proj.WithTestFiles(files)
	if view == proj {
		return proj, c
	}
	if mapped := view.ContextByID(c.ID); mapped != nil {
		return view, mapped
	}
	return view, c
}

// --- reading the answer ---

// mochaProbeAnswer is the one line mocha-probe.js answers with.
type mochaProbeAnswer struct {
	OK      bool     `json:"ok"`
	Code    string   `json:"code"`
	Error   string   `json:"error"`
	NoFiles bool     `json:"noFiles"`
	Spec    []string `json:"spec"`
	File    []string `json:"file"`
	Require []string `json:"require"`
	Import  []string `json:"import"`
}

// parseMochaProbe reads the probe script's output: the line that starts with
// the marker, whatever the project's config printed around it. An answer that
// says the probe could not load Mocha's files is an error with the reason.
func parseMochaProbe(out []byte) (*mochaProbeAnswer, error) {
	var line []byte
	for _, l := range bytes.Split(out, []byte("\n")) {
		if rest, ok := bytes.CutPrefix(bytes.TrimSpace(l), []byte(probeMarker)); ok {
			line = rest
		}
	}
	if line == nil {
		return nil, errors.New("the probe gave no answer")
	}
	var a mochaProbeAnswer
	if err := json.Unmarshal(line, &a); err != nil {
		return nil, errors.New("the probe's answer is not readable")
	}
	if !a.OK {
		if a.Code == "no_loader" {
			return nil, fmt.Errorf("this version of Mocha has none of the loader files the probe expects: %s", oneLine(a.Error, 300))
		}
		return nil, fmt.Errorf("Mocha's option loader failed: %s", oneLine(a.Error, 500))
	}
	return &a, nil
}

// testFiles turns the answer into the files of the package: project paths of
// files inside the Working copy and the package, never in node_modules.
func (a *mochaProbeAnswer) testFiles(pkg *discovery.Package, suite string) []discovery.TestFile {
	var out []discovery.TestFile
	seen := map[string]bool{}
	add := func(kind string, paths []string) {
		for _, p := range paths {
			rel, ok := projectRel(p)
			if !ok || !inPackage(pkg, rel) || seen[kind+"\x00"+rel] || hasPathSegment(rel, "node_modules") {
				continue
			}
			seen[kind+"\x00"+rel] = true
			out = append(out, discovery.TestFile{ContextID: pkg.ContextID, Path: rel, Suite: suite, Kind: kind})
		}
	}
	add("spec", a.Spec)
	add("file", a.File)
	add("require", a.Require)
	add("import", a.Import)
	return out
}

func inPackage(pkg *discovery.Package, rel string) bool {
	return pkg.Path == "." || strings.HasPrefix(rel, pkg.Path+"/")
}

func hasPathSegment(rel, segment string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == segment {
			return true
		}
	}
	return false
}

// nodeTestFilesOf expands a node:test suite from its file arguments or Node's
// default patterns, over the package's files. It needs no container. Other
// runners give nothing: their files are never chosen by name.
func nodeTestFilesOf(pkg *discovery.Package, s *discovery.Suite) []discovery.TestFile {
	if s.Runner != discovery.RunnerNodeTest {
		return nil
	}
	rels := make([]string, 0, len(pkg.Files))
	for _, f := range pkg.Files {
		rels = append(rels, f.PackageRel)
	}
	var out []discovery.TestFile
	for _, rel := range discovery.NodeTestFiles(rels, s.Args) {
		p := rel
		if pkg.Path != "." {
			p = path.Join(pkg.Path, rel)
		}
		out = append(out, discovery.TestFile{ContextID: pkg.ContextID, Path: p, Suite: s.Origin, Kind: "spec"})
	}
	return out
}

// --- running the probe ---

// runMochaProbe asks the Mocha installed in the Working copy which files the
// suite the Input is bound to loads. The container is the package's own, on the
// Run's internal network, with the suite's environment and a limit of 30
// seconds. It loads config files only.
func (in *Input) runMochaProbe(ctx context.Context) (*mochaProbeAnswer, error) {
	pkg, suite := in.Context.Package, in.suite()
	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := append([]string{"node", mochaProbePath, workPath(pkg) + "/node_modules/mocha"}, suite.Args...)
	c, err := in.Docker.RunContainer(pctx, docker.ContainerSpec{
		Name: "testfiles-" + in.suiteSuffix(), Image: in.Context.Node.Image, Cmd: cmd, Env: suite.Env,
		WorkDir: workPath(pkg), Network: in.Network,
		Mounts: []docker.Mount{{Volume: in.WorkVolume, Path: workMount}},
		Files:  []docker.File{{Path: mochaProbePath, Mode: 0o644, Content: mochaProbeScript}},
	})
	switch {
	case err == nil:
	case ctx.Err() != nil:
		return nil, ctx.Err()
	case errors.Is(err, context.DeadlineExceeded):
		return nil, fmt.Errorf("the probe did not finish within %s", probeTimeout)
	default:
		return nil, err
	}
	answer, perr := parseMochaProbe(c.Stdout)
	if perr != nil && c.ExitCode != 0 {
		return nil, fmt.Errorf("%w (exit code %d): %s", perr, c.ExitCode, oneLine(string(c.Stderr), 300))
	}
	return answer, perr
}

// suiteLabel names a suite in a Limitation.
func suiteLabel(s *discovery.Suite) string {
	if s == nil {
		return "of the package"
	}
	return fmt.Sprintf("%s (%s)", resultset.Quote(s.Origin), s.Runner)
}

// addTestFileProbe probes the suites of the package after its install and adds
// what it found to the install's result: the files for the Checks that wait for
// it, the Inventory and Measurements of the files that moved, and a Limitation
// for every suite whose probe failed. A node:test suite needs no install; a
// Mocha suite is probed only when the install completed without a Gate.
func (in *Input) addTestFileProbe(ctx context.Context, res *Result) {
	pkg := in.Context.Package
	installed := res.Status == resultset.StatusCompleted
	for _, f := range res.Findings {
		installed = installed && !f.Gate
	}
	var all []discovery.TestFile
	for i := range pkg.Tests.Suites {
		suite := &pkg.Tests.Suites[i]
		switch suite.Runner {
		case discovery.RunnerNodeTest:
			all = append(all, nodeTestFilesOf(pkg, suite)...)
		case discovery.RunnerMocha:
			if ctx.Err() != nil {
				continue
			}
			if !installed {
				res.Limitations = append(res.Limitations, in.testFilesNotResolved(suite,
					errors.New("the install of the package did not finish without a Gate, so there is no Mocha to ask")))
				continue
			}
			answer, err := in.forSuite(i).runMochaProbe(ctx)
			if err != nil {
				if ctx.Err() == nil {
					res.Limitations = append(res.Limitations, in.testFilesNotResolved(suite, err))
				}
				continue
			}
			all = append(all, answer.testFiles(pkg, suite.Origin)...)
		}
	}
	if in.Shared != nil {
		in.Shared.Put(testFilesKey(in.Context.ID), &testFilesProbe{Files: all})
	}
	moved := in.Project.MovedTestFiles(pkg, all)
	if len(moved) == 0 {
		return
	}
	if res.Inventory == nil {
		res.Inventory = &resultset.Inventory{}
	}
	perSuite := map[string]int{}
	var order []string
	for _, m := range moved {
		res.Inventory.MovedTestFiles = append(res.Inventory.MovedTestFiles,
			resultset.MovedTestFile{ContextID: in.Context.ID, Path: m.Path, Suite: m.Suite, Kind: m.Kind})
		if perSuite[m.Suite] == 0 {
			order = append(order, m.Suite)
		}
		perSuite[m.Suite]++
	}
	for _, suite := range order {
		n := float64(perSuite[suite])
		res.Metrics = append(res.Metrics, resultset.Metric{Name: "test_files.moved:" + suite, Value: &n, Unit: "files"})
	}
}

// unprobedSuiteLimitations are the Limitations of the Mocha suites of a package
// whose probe never runs (see HasTestFileProbe), with the reason it does not.
func (in *Input) unprobedSuiteLimitations() []resultset.Limitation {
	pkg := in.Context.Package
	u := unsupportedTests(pkg)
	if pkg.Tests == nil || u == nil {
		return nil
	}
	var out []resultset.Limitation
	for i := range pkg.Tests.Suites {
		if suite := &pkg.Tests.Suites[i]; suite.Runner == discovery.RunnerMocha {
			out = append(out, in.testFilesNotResolved(suite, errors.New("the probe does not run for this package: "+u.Reason)))
		}
	}
	return out
}

// testFilesNotResolved is the Limitation of a suite whose probe failed.
func (in *Input) testFilesNotResolved(s *discovery.Suite, err error) resultset.Limitation {
	id, manifest := packageInstallID, in.manifestPath()
	return resultset.Limitation{
		ReasonCode: testFilesNotResolved, CheckID: &id, Path: &manifest,
		Message: fmt.Sprintf("The test files of the suite %s could not be read from the project's own Mocha (%s), so its files keep the classes folder names and the static reading of the config give them. "+
			"Specs outside folders named test, tests, __tests__ or spec may count as Source code.", suiteLabel(s), oneLine(err.Error(), 600)),
	}
}

// --- the safety net ---

// loadedFiles lists the files the runner loaded, as far as its reporter saw
// them: the files that hold the tests it announced, the hooks that failed and
// the test files whose process failed. Each file once, in the order seen.
func (ev *suiteEvents) loadedFiles() []string {
	var out []string
	seen := map[string]bool{}
	add := func(f string) {
		if f != "" && !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	for _, t := range ev.Tests {
		add(t.File)
	}
	for _, h := range ev.Hooks {
		add(h.File)
	}
	for _, f := range ev.Files {
		add(f.File)
	}
	return out
}

// sourceSpecLimitations is the safety net behind the probe: the files the
// runner actually loaded that the Project the Check sees still classes as
// Source code. They are linted without the runner's globals and counted as
// production code, so the Report says so.
func (in *Input) sourceSpecLimitations(ev *suiteEvents) []resultset.Limitation {
	pkg := in.Context.Package
	if pkg == nil {
		return nil
	}
	class := map[string]discovery.FileClass{}
	for _, f := range pkg.Files {
		class[f.Path] = f.Class
	}
	var source []string
	for _, f := range ev.loadedFiles() {
		if rel, ok := projectRel(f); ok && class[rel] == discovery.Source {
			source = append(source, rel)
		}
	}
	if len(source) == 0 {
		return nil
	}
	id, manifest := testsExistingID, in.manifestPath()
	return []resultset.Limitation{{
		ReasonCode: "test_file_classified_as_source", CheckID: &id, Path: &manifest,
		Message: fmt.Sprintf("The runner of the suite %s loaded %d test file(s) that are classified as Source code: %s. "+
			"The Checks that read File classes lint them without the runner's globals and count them as production code, because neither the folder names nor the test file probe found them.",
			suiteLabel(in.suite()), len(source), strings.Join(source, ", ")),
	}}
}
