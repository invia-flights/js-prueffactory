package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(depsTreeID, depsTree{}) }

const depsTreeID = "deps.tree"

// depsTree runs `npm ls --all --json` on the dependencies package.install put
// into the Working copy. Missing, invalid and extraneous packages and peer
// conflicts become warnings. It is the first Check that needs the installed
// dependencies, and it shows how: it lists package.install as a prerequisite.
type depsTree struct{}

func (depsTree) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "deps.tree examines packages, and this is the project Context"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

func (depsTree) Prerequisites(*discovery.Context) []string { return []string{packageInstallID} }

func (depsTree) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (depsTree) Images(c *discovery.Context) []string { return nodeImages(c) }

func (depsTree) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	res := &Result{Command: []string{"npm", "ls", "--all", "--json"}}
	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "depstree-" + strings.ToLower(in.Context.ID), Image: in.Context.Node.Image, Cmd: res.Command,
		Env: npmEnv(nil), WorkDir: workPath(pkg), Network: in.Network,
		Mounts: []docker.Mount{{Volume: in.WorkVolume, Path: workMount, ReadOnly: true}},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := c.ExitCode
	res.Tool = &resultset.Tool{Name: "npm ls", ExitCode: &exit}
	if v := in.Context.NPM; v != nil {
		res.Tool.Version = v
	}

	problems, err := parseNPMLs(c.Stdout, c.ExitCode)
	if err != nil {
		res.Status, res.ReasonCode = resultset.StatusToolError, "npm_ls_failed"
		res.Reason = fmt.Sprintf("%v: %s", err, tail(string(c.Stderr), 400))
		return res
	}
	for _, p := range problems {
		res.Findings = append(res.Findings, in.depsTreeFinding(p))
	}
	res.Status = resultset.StatusCompleted
	return res
}

// treeProblem is one problem `npm ls` reports about the installed tree.
type treeProblem struct {
	Rule string
	Text string
}

// parseNPMLs reads the output of `npm ls --all --json`. The top-level problems
// list holds one line per problem; npm ls exits with 1 when there are any. An
// output that is not JSON, or a failure without a problem, is an error and no
// statement about the tree.
func parseNPMLs(stdout []byte, exitCode int) ([]treeProblem, error) {
	var out struct {
		Problems []string `json:"problems"`
	}
	if err := json.Unmarshal(stdout, &out); err != nil {
		return nil, fmt.Errorf("`npm ls` exited with %d and wrote no JSON", exitCode)
	}
	if exitCode != 0 && (exitCode != 1 || len(out.Problems) == 0) {
		return nil, fmt.Errorf("`npm ls` exited with %d without naming a problem", exitCode)
	}
	seen := map[string]bool{}
	var problems []treeProblem
	for _, text := range out.Problems {
		if seen[text] {
			continue
		}
		seen[text] = true
		problems = append(problems, treeProblem{Rule: treeRule(text), Text: text})
	}
	return problems, nil
}

func treeRule(problem string) string {
	switch {
	case strings.Contains(problem, "peer"):
		return "deps-peer-conflict"
	case strings.HasPrefix(problem, "missing:"):
		return "deps-missing"
	case strings.HasPrefix(problem, "invalid:"):
		return "deps-invalid"
	case strings.HasPrefix(problem, "extraneous:"):
		return "deps-extraneous"
	}
	return "deps-problem"
}

var treeTitles = map[string]string{
	"deps-missing":       "A dependency is missing from the installed tree",
	"deps-invalid":       "An installed package does not satisfy its requirement",
	"deps-extraneous":    "An installed package is not required by anything",
	"deps-peer-conflict": "A peer dependency is missing or in conflict",
	"deps-problem":       "npm ls reports a problem in the installed tree",
}

func (in *Input) depsTreeFinding(p treeProblem) resultset.Finding {
	pkg := in.Context.Package
	manifest := path.Join(pkg.Path, "package.json")
	rule := p.Rule
	// npm prints absolute paths inside the container. Show them relative to the
	// package, so the text means the same in every Run.
	text := strings.ReplaceAll(p.Text, workPath(pkg)+"/", "")
	return resultset.Finding{
		CheckID: depsTreeID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(depsTreeID, rule, manifest, text),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceConfirmed,
		Title:        treeTitles[rule],
		Message:      "`npm ls --all` reports: " + text,
		Locations:    []resultset.Location{in.Location("primary", manifest, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", text, "npm ls")},
		Reproduction: in.Reproduction(depsTreeID),
		Limitations:  []string{},
	}
}
