package checks

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

//go:embed config/redocly.yaml
var redoclyConfig []byte

func init() { Register("api.lint", apiLint{}) }

// apiLint runs Redocly CLI with the structural `spec` ruleset on every OpenAPI
// or Swagger file outside node_modules and Test data. Errors are Gates. A file
// with a remote $ref is partial, because the Execution phase has no network.
type apiLint struct{}

const (
	apiLintID          = "api.lint"
	ruleUnparseable    = "unparseable"
	reasonNotParseable = "file_not_parseable"
)

// unparseableTargets returns, for the targets that do not parse as YAML or
// JSON, why. These are the files artifacts.structured reports as a Gate, since
// api.lint and that Check read the same Snapshot with the same parser.
func unparseableTargets(in *Input, targets []openAPITarget) map[string]*parseError {
	out := map[string]*parseError{}
	for _, t := range targets {
		data, err := readProjectFile(in, t.Path)
		if err != nil {
			continue
		}
		if perr := parseStructured(t.Path, data); perr != nil {
			out[t.Path] = perr
		}
	}
	return out
}

// structuredReports says whether artifacts.structured is in the Run and looks
// at the file, so that it reports the file when it does not parse.
func structuredReports(in *Input, rel string) bool {
	if in.Selection != nil && !in.Selection.Selected(structuredID) {
		return false
	}
	checked, _, _ := structuredTargets(in.Project)
	return slices.ContainsFunc(checked, func(f discovery.File) bool { return f.Path == rel })
}

func (apiLint) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "api.lint examines the whole project, not one package"
	}
	if len(openAPITargets(p)) == 0 {
		return resultset.NotApplicable, "the project has no OpenAPI or Swagger file outside node_modules and Test data"
	}
	return resultset.Applicable, ""
}

func (apiLint) Images(c *discovery.Context) []string {
	return projectImages(c, toolset.Redocly)
}

func (apiLint) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: []resultset.ToolRef{toolRef(toolset.Redocly)}}
	targets := openAPITargets(in.Project)
	env := map[string]string{"REDOCLY_TELEMETRY": "off"}
	res.Command = []string{"redocly", "lint", "--config", "/jspf/redocly.yaml", "--format", "json", "<file>"}

	broken := unparseableTargets(in, targets)
	var unreadable []string
	worst, remoteRefs := 0, 0
	for i, target := range targets {
		perr := broken[target.Path]
		if perr != nil && structuredReports(in, target.Path) {
			// artifacts.structured has the Gate; a second one adds nothing.
			p, id := target.Path, apiLintID
			res.Limitations = append(res.Limitations, resultset.Limitation{
				ReasonCode: reasonNotParseable,
				Message:    "the file is not valid YAML or JSON, so it was not linted; artifacts.structured reports it as a Gate",
				CheckID:    &id, Path: &p,
			})
			continue
		}
		// Redocly expands every argument that has glob characters, so a path
		// is never passed: the container starts in the file's own folder and
		// gets the bare file name, which it opens literally.
		dir, base := path.Split(target.Path)
		workDir := snapshotMount + "/" + strings.TrimSuffix(dir, "/")
		if dir == "" {
			workDir = snapshotMount
		}
		if strings.HasPrefix(base, "-") {
			base = "./" + base
		}
		cmd := []string{"lint", "--config", "/jspf/redocly.yaml", "--format", "json", base}
		c, err := in.Docker.RunContainer(ctx, toolContainer(in, fmt.Sprintf("redocly-%d", i+1), toolset.Redocly, cmd, workDir, env,
			docker.File{Path: "/jspf/redocly.yaml", Mode: 0o644, Content: redoclyConfig}))
		if err != nil {
			return failedToRun(res, err)
		}
		worst = max(worst, c.ExitCode)
		res.Tool = toolInfo(toolset.Redocly, worst)

		var found []resultset.Finding
		if c.ExitCode <= 1 {
			found, err = redoclyFindings(in, target, c.Stdout, c.Stderr)
			var noJSON *redoclyNoJSON
			if errors.As(err, &noJSON) && perr != nil {
				// Without artifacts.structured nothing else says the file is broken.
				found, err = []resultset.Finding{unparseableFinding(in, target, perr, noJSON.Output)}, nil
			}
		} else {
			err = fmt.Errorf("redocly exited with %d: %s", c.ExitCode, tail(string(c.Stderr), 200))
		}
		if err != nil {
			unreadable = append(unreadable, fmt.Sprintf("%s: %v", target.Path, err))
			continue
		}
		res.Findings = append(res.Findings, found...)

		if target.RemoteRef {
			remoteRefs++
			p, id := target.Path, apiLintID
			res.Limitations = append(res.Limitations, resultset.Limitation{
				ReasonCode: "remote_ref_not_fetched",
				Message:    "the file has a remote $ref that cannot be fetched without network access, so what it points to was not linted",
				CheckID:    &id, Path: &p,
			})
		}
	}

	switch {
	case len(unreadable) == len(targets):
		res.Status, res.ReasonCode = resultset.StatusToolError, "tool_failed"
		res.Reason = "Redocly CLI failed on every file, for example " + unreadable[0]
	case len(unreadable) > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("Redocly CLI failed on %d of %d files, for example %s", len(unreadable), len(targets), unreadable[0])
	case remoteRefs > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, "remote_ref_not_fetched"
		res.Reason = fmt.Sprintf("%d file(s) have a remote $ref that cannot be fetched offline", remoteRefs)
	default:
		res.Status = resultset.StatusCompleted
	}
	return res
}
