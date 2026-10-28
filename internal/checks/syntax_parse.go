package checks

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

//go:embed js/syntax-parse.js
var syntaxParseScript []byte

func init() { Register("syntax.parse", syntaxParse{}) }

// syntaxParse runs `node --check` on every .js, .cjs and .mjs file of a
// package on the package's Node version. Parse errors in Source code and Test
// code are Gates, parse errors in Test data are notes, and Build output is
// skipped and listed.
type syntaxParse struct{}

const syntaxParseID = "syntax.parse"

func isJavaScript(rel string) bool {
	switch path.Ext(rel) {
	case ".js", ".cjs", ".mjs":
		return true
	}
	return false
}

// parseTargets returns the package's JavaScript files that are checked, and the
// Build output files that are skipped.
func parseTargets(pkg *discovery.Package) (checked, skipped []discovery.File) {
	for _, f := range pkg.Files {
		if !isJavaScript(f.PackageRel) {
			continue
		}
		if f.Class == discovery.BuildOutput {
			skipped = append(skipped, f)
		} else {
			checked = append(checked, f)
		}
	}
	return checked, skipped
}

func (syntaxParse) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "syntax.parse examines packages, and this is the project Context"
	}
	checked, _ := parseTargets(c.Package)
	if len(checked) == 0 {
		return resultset.NotApplicable, "the package has no JavaScript files outside Build output"
	}
	if u := c.Package.NodeChoice.Unsupported; u != nil {
		return resultset.Applicable, "unsupported: " + u.Reason
	}
	return resultset.Applicable, ""
}

// Images tells the engine which image Run will use.
func (s syntaxParse) Images(c *discovery.Context) []string {
	if c.Package == nil || c.Node == nil || c.Package.BuildStepReason != "" {
		return nil
	}
	if checked, _ := parseTargets(c.Package); len(checked) == 0 {
		return nil
	}
	return []string{c.Node.Image}
}

type syntaxInput struct {
	Root          string       `json:"root"`
	DisplayPrefix string       `json:"display_prefix"`
	Files         []syntaxFile `json:"files"`
}

type syntaxFile struct {
	Path string `json:"path"`
}

type syntaxOutput struct {
	NodeVersion string `json:"node_version"`
	Checked     int    `json:"checked"`
	Failures    []struct {
		Path    string `json:"path"`
		Line    int    `json:"line"`
		Column  int    `json:"column"`
		Rule    string `json:"rule"`
		Message string `json:"message"`
		Output  string `json:"output"`
	} `json:"failures"`
	Errors []struct {
		Path    string `json:"path"`
		Message string `json:"message"`
	} `json:"errors"`
}

func (syntaxParse) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	res := &Result{Limitations: skippedBuildOutput(pkg)}

	if u := pkg.NodeChoice.Unsupported; u != nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusUnsupported, u.Code, u.Reason
		return res
	}
	if pkg.BuildStepReason != "" {
		res.Status = resultset.StatusUnsupported
		res.ReasonCode = "build_step_required"
		res.Reason = "the package needs a build step before its JavaScript can run: " + pkg.BuildStepReason
		return res
	}

	checked, _ := parseTargets(pkg)
	root := "/snapshot"
	prefix := ""
	if pkg.Path != "." {
		root += "/" + pkg.Path
		prefix = pkg.Path + "/"
	}
	files := make([]syntaxFile, 0, len(checked))
	classOf := map[string]discovery.FileClass{}
	for _, f := range checked {
		files = append(files, syntaxFile{Path: f.PackageRel})
		classOf[f.Path] = f.Class
	}
	inputJSON, _ := json.Marshal(syntaxInput{Root: root, DisplayPrefix: prefix, Files: files})

	res.Command = []string{"node", "/jspf/syntax-parse.js", "/jspf/input.json"}
	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name:    "syntax-" + strings.ToLower(in.Context.ID),
		Image:   in.Context.Node.Image,
		Cmd:     res.Command,
		WorkDir: root,
		Network: in.Network,
		Mounts:  []docker.Mount{{Volume: in.SnapshotVolume, Path: "/snapshot", ReadOnly: true}},
		Files: []docker.File{
			{Path: "/jspf/syntax-parse.js", Mode: 0o644, Content: syntaxParseScript},
			{Path: "/jspf/input.json", Mode: 0o644, Content: inputJSON},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := container.ExitCode
	res.Tool = &resultset.Tool{Name: "node --check", ExitCode: &exit}

	var out syntaxOutput
	if exit != 0 || json.Unmarshal(container.Stdout, &out) != nil {
		return helperFailed(res, "syntax", container, 400)
	}
	res.Tool.Version = &out.NodeVersion

	sort.Slice(out.Failures, func(i, j int) bool { return out.Failures[i].Path < out.Failures[j].Path })
	for _, f := range out.Failures {
		inTestData := classOf[f.Path] == discovery.TestData
		finding := resultset.Finding{
			CheckID: syntaxParseID, ContextID: in.Context.ID,
			RuleID:      &f.Rule,
			Fingerprint: resultset.NewFingerprint(syntaxParseID, f.Rule, f.Path, f.Message),
			Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
			Confidence: resultset.ConfidenceConfirmed, Gate: true, InTestData: inTestData,
			Title:   "JavaScript file does not parse",
			Message: "node --check reports a syntax error in this file.",
			Locations: []resultset.Location{
				in.Location("primary", f.Path, f.Line, f.Column),
			},
			Evidence:     []resultset.Evidence{Untrusted("tool_output", f.Output, "node --check")},
			Reproduction: in.Reproduction(syntaxParseID),
			Limitations:  []string{},
		}
		if inTestData {
			finding.Severity = resultset.SeverityNote
			finding.Gate = false
			finding.Message = "node --check reports a syntax error in a Test data file. Test data may be invalid on purpose, so this is only a note."
		}
		res.Findings = append(res.Findings, finding)
	}

	if len(out.Errors) > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("node --check could not be run on %d of %d files, for example %s: %s",
			len(out.Errors), out.Checked, out.Errors[0].Path, out.Errors[0].Message)
		return res
	}
	res.Status = resultset.StatusCompleted
	return res
}

// failedToRun turns a driver error into an Execution status.
func failedToRun(res *Result, err error) *Result {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		res.Status, res.ReasonCode, res.Reason = resultset.StatusTimedOut, "timeout", "the Check ran into its time limit"
	case errors.Is(err, context.Canceled):
		res.Status, res.ReasonCode, res.Reason = resultset.StatusCancelled, "cancelled", "the Run was cancelled"
	default:
		res.Status, res.ReasonCode, res.Reason = resultset.StatusInfrastructureError, "docker_error", err.Error()
	}
	return res
}

// skippedBuildOutput lists the Build output the Check did not look at, one
// Limitation per build folder or minified file.
func skippedBuildOutput(pkg *discovery.Package) []resultset.Limitation {
	_, skipped := parseTargets(pkg)
	counts := map[string]int{}
	for _, f := range skipped {
		counts[buildOutputRoot(f.Path)]++
	}
	roots := make([]string, 0, len(counts))
	for r := range counts {
		roots = append(roots, r)
	}
	sort.Strings(roots)
	var out []resultset.Limitation
	for _, r := range roots {
		p, id := r, syntaxParseID
		out = append(out, resultset.Limitation{
			ReasonCode: "build_output_skipped",
			Message:    fmt.Sprintf("%d JavaScript file(s) not examined because they are Build output", counts[r]),
			CheckID:    &id, Path: &p,
		})
	}
	return out
}

// buildOutputRoot returns the shortest path that makes a file Build output: the
// build folder itself, or the file for a minified file.
func buildOutputRoot(file string) string {
	parts := strings.Split(file, "/")
	for i, part := range parts[:len(parts)-1] {
		switch part {
		case "dist", "build", "coverage":
			return strings.Join(parts[:i+1], "/")
		}
	}
	return file
}
