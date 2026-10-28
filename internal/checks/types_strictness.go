package checks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(typesStrictnessID, typesStrictness{}) }

const typesStrictnessID = "types.strictness"

// typesStrictness measures how much of a package's JavaScript TypeScript can
// check, and what strict mode would add. It has two parts:
//
//   - The strict gap: TypeScript 6 runs twice over the generated tsconfig of
//     types.javascript, once with its basic profile and once with `strict`
//     on. An error that only the strict run reports is a note with its TS
//     code. They are suspected and never Gates, because strict mode is a bar
//     the project never promised to meet. The metric strict_gap_errors counts
//     all of them, before the cap on Findings.
//   - Type coverage: type-coverage, with its strict mode and without `catch`
//     variables, over the strict config. type_coverage_percent is the share of
//     identifiers in Source code that have a type and not `any`, and it is the
//     value of the Benchmark part. Test code is measured on its own and is
//     only a metric.
//
// TypeScript 6 comes from the toolset volume through the @typescript/typescript6
// alias, because type-coverage needs a compiler API that TypeScript 7 does not
// ship. Everything else is shared with types.javascript: the generated config
// and its file lists, the packages that are unsupported because they need a
// build step, the resolution-error rules and the Limitation that names the
// missing project tsconfig. The project's own tsconfig is never read, and
// neither is the typeCoverage section of its package.json: type-coverage runs
// in the folder of the generated configs, not in the package's.
type typesStrictness struct{ typesJavascript }

const (
	typesStrictConfigPath = "/jspf/tsconfig.strict.json"
	typesTestsConfigPath  = "/jspf/tsconfig.tests.json"
	// typeCoverageDir is where type-coverage runs. It holds no package.json, so
	// that nothing of the project configures the tool. Files outside the
	// current folder are measured because of --not-only-in-cwd, and named
	// relative to this folder.
	typeCoverageDir = "/jspf"
)

func (typesStrictness) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "types.strictness examines packages, and this is the project Context"
	}
	return typesApplicability(c)
}

// typesTestTargets lists the files of the package's Test code that TypeScript
// can read, relative to the package folder and sorted, as typesTargets does for
// Source code.
func typesTestTargets(in *Input) []string {
	var out []string
	for _, f := range in.Context.Package.Files {
		if f.Class != discovery.TestCode || !typesCandidate(f.PackageRel) {
			continue
		}
		if _, ok := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(f.PackageRel))); !ok {
			continue
		}
		out = append(out, f.PackageRel)
	}
	sort.Strings(out)
	return out
}

// typeCoverage is what type-coverage prints with --json-output.
type typeCoverage struct {
	Correct int `json:"correctCount"`
	Total   int `json:"totalCount"`
}

// parseTypeCoverage reads the JSON document of type-coverage. It insists on
// the two counts, because the run is not a statement about the project when
// they are missing.
func parseTypeCoverage(out []byte) (typeCoverage, error) {
	var doc struct {
		Correct *int   `json:"correctCount"`
		Total   *int   `json:"totalCount"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		return typeCoverage{}, fmt.Errorf("type-coverage did not print its JSON document: %w", err)
	}
	if doc.Correct == nil || doc.Total == nil || *doc.Correct < 0 || *doc.Correct > *doc.Total {
		return typeCoverage{}, errors.New("type-coverage printed no usable identifier counts")
	}
	return typeCoverage{Correct: *doc.Correct, Total: *doc.Total}, nil
}

// Percent is the share of typed identifiers, computed from the counts and not
// from the rounded printout. Code without identifiers has nothing untyped.
func (c typeCoverage) Percent() float64 {
	if c.Total == 0 {
		return 100
	}
	return 100 * float64(c.Correct) / float64(c.Total)
}

// tscRun is what one run of tsc left: the diagnostics of its text output, the
// ones without a file, and its exit code.
type tscRun struct {
	Diagnostics []tscDiagnostic
	Global      []string
	Exit        int
}

// problem says whether a run of tsc says nothing about the project: it
// crashed, or complained about the generated configuration, or exited with an
// error and no diagnostic.
func (r tscRun) problem() (code, reason string) {
	switch {
	case r.Exit < 0 || r.Exit > 2:
		return "tsc_failed", fmt.Sprintf("tsc exited with %d", r.Exit)
	case len(r.Global) > 0:
		return "tsc_config_error", "tsc reported a problem with the generated configuration: " + strings.Join(cutList(r.Global, 3), "; ")
	case r.Exit != 0 && len(r.Diagnostics) == 0:
		return "tsc_failed", fmt.Sprintf("tsc exited with %d and reported no error", r.Exit)
	}
	return "", ""
}

// tscKey names a diagnostic by where it is and what it says about the code, not
// by its wording: strict mode rewords some messages of errors that the basic
// profile reports too, and those are no strict gap.
func tscKey(d tscDiagnostic) string {
	return fmt.Sprintf("%s:%d:%d:%s", path.Clean(d.Path), d.Line, d.Column, d.Code)
}

// interpretStrictness turns the two tsc runs and the type-coverage counts into
// the Result. tests is nil when the package has no Test code that TypeScript
// reads.
func interpretStrictness(in *Input, basic, strict tscRun, source typeCoverage, tests *typeCoverage) *Result {
	res := &Result{}
	if tool, ok := toolset.NPMTool("typescript6"); ok {
		v, code := tool.Version, strict.Exit
		res.Tool = &resultset.Tool{Name: "tsc6", Version: &v, ExitCode: &code}
	}
	for _, name := range []string{"typescript6", "type-coverage", "@types/node", "@types/mocha"} {
		if tool, ok := toolset.NPMTool(name); ok {
			integrity := tool.Integrity
			res.ContextTools = append(res.ContextTools, resultset.ToolRef{Name: tool.Name, Version: tool.Version, Digest: &integrity})
		}
	}
	for _, run := range []struct {
		profile string
		r       tscRun
	}{{"basic", basic}, {"strict", strict}} {
		if code, reason := run.r.problem(); code != "" {
			res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, code, "the "+run.profile+" profile run: "+reason
			return res
		}
	}

	pkg := in.Context.Package
	sourceFiles := map[string]bool{}
	for _, f := range typesTargets(in) {
		sourceFiles[f] = true
	}
	inBasic := map[string]bool{}
	for _, d := range basic.Diagnostics {
		inBasic[tscKey(d)] = true
	}
	var gap []resultset.Finding
	strictErrors, resolution := 0, 0
	for _, d := range strict.Diagnostics {
		rel := path.Clean(d.Path)
		if d.Category == "message" || !sourceFiles[rel] {
			continue
		}
		if _, _, ok := typesNodeLoadsJSON(in, rel, d); ok {
			continue
		}
		strictErrors++
		if typesResolutionCodes[d.Code] {
			resolution++
		}
		if inBasic[tscKey(d)] {
			continue
		}
		f := repoFinding(in, typesStrictnessID, toolProblem{
			Tool: "tsc", Rule: d.Code, Level: "note", Path: path.Join(pkg.Path, rel),
			Line: d.Line, Column: d.Column, Message: d.Message, Raw: rawJSON(d),
		})
		f.Message = fmt.Sprintf("tsc reports %s only in strict mode: %s", d.Code, d.Message)
		gap = append(gap, f)
	}

	metric := func(name, unit string, v float64) {
		res.Metrics = append(res.Metrics, resultset.Metric{Name: name, Unit: unit, Value: &v})
	}
	metric("type_coverage_percent", "percent", source.Percent())
	metric("type_coverage_identifiers", "identifiers", float64(source.Total))
	if tests != nil {
		metric("type_coverage_test_code_percent", "percent", tests.Percent())
	}
	metric("strict_gap_errors", "errors", float64(len(gap)))
	metric("resolution_errors", "errors", float64(resolution))

	// Errors that only exist because the generated config cannot see the
	// project's own, counted over all errors of the strict run. They also
	// lower the type coverage, because an unresolved import is an `any`.
	res.Limitations = append(res.Limitations, projectTsconfigNotUsed(typesStrictnessID, resolution, strictErrors,
		"The type coverage is lower where an import cannot be resolved. Treat these results with care.")...)
	if len(gap) > typesMaxFindings {
		id := typesStrictnessID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id,
			Message: fmt.Sprintf("The Report keeps the first %d strict-mode errors; %d more were found and are left out. The metric strict_gap_errors counts all of them.",
				typesMaxFindings, len(gap)-typesMaxFindings),
		})
		// The Check stays completed: the cut only shortens the list of notes,
		// and the type coverage and the metric strict_gap_errors are complete.
		gap = gap[:typesMaxFindings]
	}
	res.Findings = gap
	if res.Status == "" {
		res.Status = resultset.StatusCompleted
	}
	return res
}

func (typesStrictness) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if code, reason := typesUnsupported(pkg); reason != "" {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: code, Reason: reason}
	}
	res := &Result{}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("TypeScript 6 and type-coverage")
	}
	files := typesTargets(in)
	if len(files) == 0 {
		res.Status = resultset.StatusCompleted
		return res
	}
	testFiles := typesTestTargets(in)
	node := ""
	if in.Context.Node != nil {
		node = in.Context.Node.Version
	}

	basicConfig, err := typesTsconfigFor(files, pkg.Path, node, pkg.UsesMocha(), false)
	var strictConfig, testsConfig []byte
	if err == nil {
		strictConfig, err = typesTsconfigFor(files, pkg.Path, node, pkg.UsesMocha(), true)
	}
	if err == nil && len(testFiles) > 0 {
		testsConfig, err = typesTsconfigFor(testFiles, pkg.Path, node, pkg.UsesMocha(), true)
	}
	if err != nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "internal_error", err.Error()
		return res
	}
	configs := []docker.File{
		{Path: typesConfigPath, Mode: 0o644, Content: basicConfig},
		{Path: typesStrictConfigPath, Mode: 0o644, Content: strictConfig},
	}
	if testsConfig != nil {
		configs = append(configs, docker.File{Path: typesTestsConfigPath, Mode: 0o644, Content: testsConfig})
	}

	// start runs one tool in its own container, on the same image and mounts as
	// types.javascript, and returns its result or the Result that ends the Check.
	start := func(name, workDir string, cmd []string) (*docker.ContainerResult, *Result) {
		container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
			Name: name + "-" + strings.ToLower(in.Context.ID), Image: typesImage(), Cmd: cmd,
			WorkDir: workDir, Network: in.Network,
			Mounts: []docker.Mount{
				{Volume: in.WorkVolume, Path: workMount, ReadOnly: true},
				{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
			},
			Files: configs,
		})
		if err != nil {
			return nil, failedToRun(&Result{}, err)
		}
		if container.OOMKilled {
			return nil, &Result{Status: resultset.StatusToolError, ReasonCode: "tsc_failed",
				Reason: name + " ran out of memory: " + tail(string(container.Stderr), 400)}
		}
		return container, nil
	}
	tsc := func(name, config string) (tscRun, []string, *Result) {
		cmd := []string{"node", toolvolume.ToolBin + "/@typescript/typescript6/bin/tsc6", "-p", config, "--pretty", "false"}
		container, stop := start(name, workPath(pkg), cmd)
		if stop != nil {
			return tscRun{}, nil, stop
		}
		diags, global := parseTSC(string(container.Stdout))
		return tscRun{Diagnostics: diags, Global: global, Exit: container.ExitCode}, cmd, nil
	}
	coverage := func(name, config string, targets []string) (typeCoverage, *Result) {
		cmd := []string{"node", toolvolume.ToolBin + "/type-coverage/bin/type-coverage", "-p", config,
			"--strict", "--ignore-catch", "--json-output", "--not-only-in-cwd", "--"}
		for _, f := range targets {
			cmd = append(cmd, "../"+strings.TrimPrefix(workPath(pkg), "/")+"/"+f)
		}
		container, stop := start(name, typeCoverageDir, cmd)
		if stop != nil {
			return typeCoverage{}, stop
		}
		got, err := parseTypeCoverage(container.Stdout)
		if err != nil {
			return typeCoverage{}, &Result{Status: resultset.StatusToolError, ReasonCode: "type_coverage_failed",
				Reason: err.Error() + ": " + tail(string(container.Stderr)+"\n"+string(container.Stdout), 800)}
		}
		return got, nil
	}

	basic, _, stop := tsc("strictness-basic", typesConfigPath)
	if stop != nil {
		return stop
	}
	strict, command, stop := tsc("strictness-strict", typesStrictConfigPath)
	if stop != nil {
		return stop
	}
	source, stop := coverage("coverage-source", typesStrictConfigPath, files)
	if stop != nil {
		return stop
	}
	var tests *typeCoverage
	if len(testFiles) > 0 {
		t, stop := coverage("coverage-tests", typesTestsConfigPath, testFiles)
		if stop != nil {
			return stop
		}
		tests = &t
	}

	out := interpretStrictness(in, basic, strict, source, tests)
	out.Command = command
	out.Artifacts = append(out.Artifacts, resultset.Artifact{
		ID:   "tsconfig-strict-" + in.Context.ID,
		Path: "artifacts/" + typesStrictnessID + "/" + in.Context.ID + "-tsconfig-strict.json", MediaType: "application/json",
		Content: append(strictConfig, '\n'),
	})
	return out
}
