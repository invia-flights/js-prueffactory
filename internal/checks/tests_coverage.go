package checks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(testsCoverageID, testsCoverage{}) }

// testsCoverage reports the line, branch and function Coverage of a package's
// own test run. It does not run the suite a second time: the suite's one run
// is shared with tests.existing (see sharedSuite), and when tests.coverage is
// selected, c8 from the toolset wraps the runner of that run. Whichever of the
// two Checks starts first performs the run; the other reads its result.
//
// Coverage is a measurement. It has no Findings and no Gates. A suite with
// failing tests still has coverage, and its metrics carry a note.
type testsCoverage struct{}

func (testsCoverage) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "tests.coverage measures the tests of a package, and this is the project Context"
	}
	return testsExisting{}.Applicability(p, c)
}

func (testsCoverage) Prerequisites(c *discovery.Context) []string {
	return testsExisting{}.Prerequisites(c)
}

func (testsCoverage) UsesWorkingCopy() bool { return true }

func (testsCoverage) Images(c *discovery.Context) []string { return testsExisting{}.Images(c) }

// UsesServices: when this Check performs the suite's run, the suite gets the
// project's test Services like it does for tests.existing.
func (testsCoverage) UsesServices(c *discovery.Context) bool { return testsExisting{}.UsesServices(c) }

// UsesToolset says that c8 comes from the toolset volume.
func (testsCoverage) UsesToolset(c *discovery.Context) bool { return testsExisting{}.runnable(c) }

func (testsCoverage) Run(ctx context.Context, in *Input) *Result {
	return in.coverageResult(in.sharedSuite(ctx))
}

// Run of tests.existing is the suite's result, whoever performed the run.
func (t testsExisting) Run(ctx context.Context, in *Input) *Result {
	r := *in.sharedSuite(ctx)
	r.coverage, r.parts = nil, nil
	return &r
}

// sharedSuite returns the one run of the package's suites in the Context (all
// of them, in list order, see runSuites), performing it if neither
// tests.existing nor tests.coverage has. Unlike a
// result that depends on the caller's limit, the suite's result is kept even
// when the run was cut short, because it says what the tests did, and running
// the tests again would take as long again.
func (in *Input) sharedSuite(ctx context.Context) *Result {
	shared := in.Shared
	if shared == nil {
		shared = NewShared()
	}
	v := shared.Do(ctx, "tests.existing/"+in.Context.ID, func(ctx context.Context) (any, bool) {
		return runSuites(ctx, in), true
	})
	return v.(*Result)
}

// coverageRun is what a suite run recorded for coverage.
type coverageRun struct {
	// Unavailable says why c8 could not wrap the run; the tests ran without it.
	// UnavailableCode is the reason code of the Check then, "toolset_unavailable"
	// when empty.
	Unavailable, UnavailableCode string
	// Summary and PerFile are c8's JSON summary and per-file JSON, nil when c8
	// wrote none.
	Summary, PerFile []byte
}

// wantsCoverage says whether the run is to be measured: tests.coverage is in
// the Selection.
func (in *Input) wantsCoverage() bool {
	if in.repeat != nil {
		return false // a repeat run is never measured
	}
	return in.Selection == nil || in.Selection.Selected(testsCoverageID)
}

// addCoverage puts c8 around the runner of a suite container when the run is to
// be measured. The c8 of every suite adds its raw coverage to the package's one
// coverage volume (see withCoverageLocation). It returns what the run needs to
// remember, or nil when the run is not measured.
func (in *Input) addCoverage(spec *docker.ContainerSpec) *coverageRun {
	if !in.wantsCoverage() {
		return nil
	}
	if in.ToolsetVolume == "" {
		return &coverageRun{Unavailable: "the toolset volume with c8 could not be prepared: " + in.ToolsetError}
	}
	if in.coverageVolume == "" {
		why := in.coverageError
		if why == "" {
			why = "there is no volume for the raw coverage"
		}
		return &coverageRun{Unavailable: why, UnavailableCode: "coverage_location_unavailable"}
	}
	spec.Cmd = wrapWithC8(spec.Cmd)
	spec.Mounts = append(spec.Mounts,
		docker.Mount{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		docker.Mount{Volume: in.coverageVolume, Path: coverageMount})
	spec.Files = append(spec.Files, docker.File{Path: c8ConfigPath, Mode: 0o644, Content: suiteCoverageConfig(in.Project, in.Context.Package)})
	return &coverageRun{}
}

// withCoverageLocation returns the Input for the run of all suites of the
// package. When tests.coverage is selected it holds the one run-owned volume
// that every suite writes its raw V8 coverage into, or says why there is none.
func (in *Input) withCoverageLocation(ctx context.Context) *Input {
	run := *in
	if !in.wantsCoverage() {
		return &run
	}
	vol, err := createCoverageVolume(ctx, in)
	if err != nil {
		run.coverageError = "the volume for the raw coverage could not be created: " + err.Error()
		return &run
	}
	run.coverageVolume = vol
	return &run
}

// sharedCoverage is what the runs of the suites recorded for coverage, as one:
// when any suite was measured, one c8 report over the raw coverage of all of
// them. It is nil when no suite reached its tests. The report is built whatever
// became of the suites, because their raw coverage is in the volume however
// their runs ended.
func (in *Input) sharedCoverage(ctx context.Context, parts []*Result) *coverageRun {
	measured := false
	for _, p := range parts {
		switch {
		case p.coverage == nil:
		case p.coverage.Unavailable != "":
			return p.coverage
		default:
			measured = true
		}
	}
	if !measured {
		return nil
	}
	cov := &coverageRun{}
	cov.Summary, cov.PerFile = buildCoverageReport(ctx, in)
	return cov
}

// createCoverageVolume makes the volume for the raw coverage of the suites of
// one package. Tests replace it.
var createCoverageVolume = func(ctx context.Context, in *Input) (string, error) {
	if in.Docker == nil {
		return "", errors.New("there is no Docker driver")
	}
	return in.Docker.CreateVolume(ctx, "coverage-"+strings.ToLower(in.Context.ID))
}

// coverageReportTimeout is how long the one c8 report over all suites gets. It
// does not depend on the Check's own context, like the reading of the events:
// the raw coverage is there after a timeout as well.
const coverageReportTimeout = 5 * time.Minute

// buildCoverageReport runs `c8 report` over the raw coverage in the Input's
// coverage volume, with the Working copy mounted read-only for the files no
// suite loaded (--all), and reads the JSON summary and the per-file JSON. Both
// are nil when c8 wrote none. Tests replace it.
var buildCoverageReport = func(ctx context.Context, in *Input) (summary, perFile []byte) {
	pkg := in.Context.Package
	image := in.Context.Node.Image
	suffix := strings.ToLower(in.Context.ID)
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), coverageReportTimeout)
	defer cancel()
	c, err := in.Docker.RunContainer(rctx, docker.ContainerSpec{
		Name: "coveragereport-" + suffix, Image: image,
		Cmd: []string{"node", c8Bin, "report", "--config", c8ConfigPath}, WorkDir: workPath(pkg), Network: docker.NetworkNone,
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: workMount, ReadOnly: true},
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
			{Volume: in.coverageVolume, Path: coverageMount},
		},
		Files: []docker.File{{Path: c8ConfigPath, Mode: 0o644, Content: coverageConfig(in.Project, pkg)}},
	})
	if err != nil || c.ExitCode != 0 {
		return nil, nil
	}
	summary = in.readVolumeFile(ctx, image, in.coverageVolume, "coverage-summary-"+suffix, coverageSummaryFile)
	if summary != nil {
		perFile = in.readVolumeFile(ctx, image, in.coverageVolume, "coverage-files-"+suffix, coverageFilesFile)
	}
	return summary, perFile
}

func (in *Input) readVolumeFile(ctx context.Context, image, volume, name, file string) []byte {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	c, err := in.Docker.RunContainer(rctx, docker.ContainerSpec{
		Name: name, Image: image, Cmd: []string{"cat", file},
		Mounts:  []docker.Mount{{Volume: volume, Path: coverageMount, ReadOnly: true}},
		Network: docker.NetworkNone,
	})
	if err != nil || c.ExitCode != 0 {
		return nil
	}
	return c.Stdout
}

// coverageResult is the result of tests.coverage, from the suite's one run.
func (in *Input) coverageResult(suite *Result) *Result {
	res := &Result{Command: suite.Command, Tool: suite.Tool}
	if in.Selection != nil && !in.Selection.Selected(testsExistingID) {
		// Nothing else reports this run: its Services and the overrides of the
		// project's command are reported here.
		res.Services, res.Limitations = suite.Services, suite.Limitations
	}
	cov := suite.coverage
	switch {
	case suite.Status == resultset.StatusUnsupported:
		res.Status, res.ReasonCode, res.Reason = suite.Status, suite.ReasonCode, suite.Reason
		return res
	case cov == nil:
		// The suite stopped before its tests were run: the runner is not
		// installed, the Services did not come up, or there was no container.
		res.Status, res.ReasonCode, res.Reason = suite.Status, suite.ReasonCode, suite.Reason
		why := suite.Reason
		for _, f := range suite.Findings {
			if f.Gate && why == "" {
				why = f.Title
			}
		}
		res.Metrics = unmeasuredCoverage("the tests did not run, so there is no coverage: " + why)
		return res
	case cov.Unavailable != "":
		code := cov.UnavailableCode
		if code == "" {
			code = "toolset_unavailable"
		}
		res.Status, res.ReasonCode, res.Reason = resultset.StatusInfrastructureError, code, cov.Unavailable
		return res
	}
	res.Tool = c8Tool(suite.Tool)
	if tool, ok := toolset.NPMTool("c8"); ok {
		integrity := tool.Integrity
		res.ContextTools = []resultset.ToolRef{{Name: tool.Name, Version: tool.Version, Digest: &integrity}}
	}

	var measured *coverage
	if cov.Summary == nil {
		reason := "c8 wrote no coverage report"
		if suite.Status != resultset.StatusCompleted {
			res.Status, res.ReasonCode, res.Reason = suite.Status, suite.ReasonCode, suite.Reason
			reason = "the test run did not finish, so c8 wrote no coverage report: " + suite.Reason
		} else {
			res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "no_coverage_output", reason+" although the test run finished"
		}
		res.Metrics = unmeasuredCoverage(reason)
		return res
	}
	pkg := in.Context.Package
	measured = interpretCoverage(cov.Summary, cov.PerFile, workPath(pkg), pkg.Path)
	if measured.Err != "" {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "coverage_output_unreadable", measured.Err
		res.Metrics = unmeasuredCoverage(measured.Err)
		return res
	}
	if note := in.coverageNote(suite); note != "" {
		measured.NoteFailures(note)
	}
	res.Status = resultset.StatusCompleted
	res.Metrics = measured.Metrics
	res.Artifacts = []resultset.Artifact{{
		ID:   "files-" + in.Context.ID,
		Path: "artifacts/" + testsCoverageID + "/" + in.Context.ID + "-files.json", MediaType: "application/json",
		Content: measured.FilesDocument,
	}}
	return res
}

// c8Tool is the Tool of the Check: c8, which returned the exit code of the
// runner it wrapped.
func c8Tool(suite *resultset.Tool) *resultset.Tool {
	t := &resultset.Tool{Name: "c8"}
	if tool, ok := toolset.NPMTool("c8"); ok {
		v := tool.Version
		t.Version = &v
	}
	if suite != nil {
		t.ExitCode = suite.ExitCode
	}
	return t
}

// unmeasuredCoverage is the three metrics of a package that could not be
// measured: null, with the reason, never a made-up number.
func unmeasuredCoverage(reason string) []resultset.Metric {
	var out []resultset.Metric
	for _, k := range coverageKinds {
		r := reason
		out = append(out, resultset.Metric{Name: k.name, Unit: "percent", Reason: &r})
	}
	return out
}

// coverageNote says what is wrong with the runs that coverage was measured on:
// the problems of the suites together (see suiteNote) and the suites of a
// package with several that did not get as far as their tests, whose coverage
// is missing from the union.
func (in *Input) coverageNote(suite *Result) string {
	parts := []string{}
	if note := suiteNote(suite); note != "" {
		parts = append(parts, note)
	}
	if len(suite.parts) > 1 {
		for i, p := range suite.parts {
			if p.coverage == nil && i < suiteCount(in.Context.Package) {
				parts = append(parts, in.Context.Package.Tests.Suites[i].Origin+" did not run its tests, so what only it reaches is not counted")
			}
		}
	}
	return strings.Join(parts, "; ")
}

// suiteNote says what is wrong with the run that coverage was measured on, or
// "" when nothing is.
func suiteNote(suite *Result) string {
	var parts []string
	failed := 0
	if suite.Inventory != nil {
		for _, p := range suite.Inventory.Tests {
			failed += p.Failed
		}
	}
	gates := 0
	for _, f := range suite.Findings {
		if f.Gate {
			gates++
		}
	}
	switch {
	case failed == 1:
		parts = append(parts, "1 test failed")
	case failed > 1:
		parts = append(parts, fmt.Sprintf("%d tests failed", failed))
	case gates > 0:
		parts = append(parts, "the suite has failures (a failed hook, a test file that fails to load or a run that stopped early)")
	}
	if suite.Status != resultset.StatusCompleted {
		parts = append(parts, "the test run did not finish: "+suite.Reason)
	}
	return strings.Join(parts, "; ")
}
