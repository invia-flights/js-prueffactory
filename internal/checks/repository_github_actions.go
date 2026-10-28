package checks

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// workflowsFolder is where GitHub reads workflows: the files directly in it.
const workflowsFolder = ".github/workflows"

func init() { Register(githubActionsID, githubActionsCheck{}) }

// githubActionsCheck lints the project's GitHub Actions workflows with
// actionlint and audits them with zizmor, both offline, each in its official
// image with the Snapshot read-only.
//
// What actionlint finds is a Gate, except the problems of its embedded
// ShellCheck and pyflakes, which are warnings. What zizmor finds is a warning
// or a note, by its severity, and never a Gate.
//
// Neither tool reads the project's own configuration: a workflow author must
// not be able to switch off the rules that audit the workflow. actionlint gets
// an empty one, and zizmor runs with --no-config. Inline `zizmor: ignore`
// comments keep working, like the inline directives of repository.shell.
type githubActionsCheck struct{}

func (githubActionsCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.github-actions examines the whole project, not one package"
	}
	if len(workflowFiles(p)) == 0 {
		return resultset.NotApplicable, "the project has no .yml or .yaml file in .github/workflows"
	}
	return resultset.Applicable, ""
}

func (githubActionsCheck) Images(c *discovery.Context) []string {
	if c.Package != nil {
		return nil
	}
	return []string{toolset.Actionlint.Image.Ref(), toolset.Zizmor.Image.Ref()}
}

// workflowFiles returns the `.yml` and `.yaml` files directly in
// .github/workflows at the project root, in path order. GitHub reads no
// subfolder and no other file there.
func workflowFiles(p *discovery.Project) []string {
	var out []string
	for _, f := range p.Files {
		dir, base := path.Split(f.Path)
		if dir != workflowsFolder+"/" {
			continue
		}
		if ext := path.Ext(base); ext == ".yml" || ext == ".yaml" {
			out = append(out, f.Path)
		}
	}
	sort.Strings(out)
	return out
}

// actionlintConfig replaces the project's .github/actionlint.yaml.
var actionlintConfig = []byte("# js-prueffactory does not read the project's actionlint configuration.\n")

func (githubActionsCheck) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: []resultset.ToolRef{toolRef(toolset.Actionlint), toolRef(toolset.Zizmor)}}
	files := workflowFiles(in.Project)
	paths := make([]string, len(files))
	for i, rel := range files {
		paths[i] = snapshotPath(rel)
	}

	lintBase := []string{"-config-file", "/jspf/actionlint.yaml", "-format", "{{json .}}"}
	res.Command = recordedCommand(append([]string{"actionlint"}, lintBase...), paths)
	ok := runChunks(ctx, in, res, toolset.Actionlint, paths,
		func(n int, chunk []string) docker.ContainerSpec {
			// The image's entrypoint is actionlint.
			cmd := append(append([]string{}, lintBase...), chunk...)
			return toolContainer(in, fmt.Sprintf("actionlint-%d", n), toolset.Actionlint, cmd, "", nil,
				docker.File{Path: "/jspf/actionlint.yaml", Mode: 0o644, Content: actionlintConfig})
		},
		func(_ []string, stdout []byte) error {
			found, err := actionlintFindings(in, stdout)
			res.Findings = append(res.Findings, found...)
			return err
		})
	if !ok {
		return res
	}
	// The Execution's tool is actionlint, whose results can be Gates.
	lintTool := res.Tool

	if !runZizmor(ctx, in, res, paths) {
		return res
	}
	res.Tool = lintTool

	sort.SliceStable(res.Findings, func(i, j int) bool {
		a, b := res.Findings[i].Locations[0], res.Findings[j].Locations[0]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return startLine(a) < startLine(b)
	})
	res.Status = resultset.StatusCompleted
	return res
}

// zizmorNoInputs is what zizmor says, with exit code 3 and no JSON, when none
// of the files it was given is a valid workflow. actionlint reports those
// files, so that is no failure of zizmor.
const zizmorNoInputs = "no inputs collected"

// runZizmor audits the workflows and adds its Findings to res. It returns false
// with res set when zizmor could not run. --no-exit-codes makes every exit
// code but 0 a failure of zizmor itself.
func runZizmor(ctx context.Context, in *Input, res *Result, paths []string) bool {
	base := []string{"--offline", "--no-config", "--no-exit-codes", "--no-progress", "--format", "json"}
	for n, chunk := range chunks(paths, filesPerContainer) {
		// The image's entrypoint is zizmor.
		cmd := append(append([]string{}, base...), chunk...)
		c, err := in.Docker.RunContainer(ctx, toolContainer(in, fmt.Sprintf("zizmor-%d", n+1), toolset.Zizmor, cmd, "", nil))
		if err != nil {
			failedToRun(res, err)
			return false
		}
		if c.ExitCode == 3 && len(strings.TrimSpace(string(c.Stdout))) == 0 && strings.Contains(string(c.Stderr), zizmorNoInputs) {
			continue
		}
		if c.ExitCode != 0 {
			res.Tool = toolInfo(toolset.Zizmor, c.ExitCode)
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_failed"
			res.Reason = fmt.Sprintf("zizmor exited with %d: %s", c.ExitCode, tail(string(c.Stderr), 400))
			return false
		}
		found, err := zizmorFindings(in, c.Stdout)
		if err != nil {
			res.Tool = toolInfo(toolset.Zizmor, c.ExitCode)
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_output_unreadable"
			res.Reason = fmt.Sprintf("%v: %s", err, tail(string(c.Stderr), 400))
			return false
		}
		res.Findings = append(res.Findings, found...)
	}
	return true
}
