package checks

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

//go:embed config/hadolint.yaml
var hadolintConfig []byte

func init() { Register("repository.dockerfile", dockerfileCheck{}) }

// dockerfileCheck runs hadolint on every Dockerfile outside node_modules and
// Test data. Error-level results are Gates.
type dockerfileCheck struct{}

func (dockerfileCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.dockerfile examines the whole project, not one package"
	}
	if len(dockerfileTargets(p)) == 0 {
		return resultset.NotApplicable, "the project has no Dockerfile outside node_modules and Test data"
	}
	return resultset.Applicable, ""
}

func (dockerfileCheck) Images(c *discovery.Context) []string {
	return projectImages(c, toolset.Hadolint)
}

func (dockerfileCheck) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: []resultset.ToolRef{toolRef(toolset.Hadolint)}}
	targets := dockerfileTargets(in.Project)

	base := []string{"/bin/hadolint", "--config", "/jspf/hadolint.yaml", "-f", "json"}
	paths := make([]string, len(targets))
	for i, rel := range targets {
		paths[i] = snapshotPath(rel)
	}
	res.Command = recordedCommand(base, paths)

	ok := runChunks(ctx, in, res, toolset.Hadolint, paths,
		func(n int, chunk []string) docker.ContainerSpec {
			cmd := append(append([]string{}, base...), chunk...)
			return toolContainer(in, fmt.Sprintf("hadolint-%d", n), toolset.Hadolint, cmd, "", nil,
				docker.File{Path: "/jspf/hadolint.yaml", Mode: 0o644, Content: hadolintConfig})
		},
		func(_ []string, stdout []byte) error {
			found, err := hadolintFindings(in, stdout)
			res.Findings = append(res.Findings, found...)
			return err
		})
	if !ok {
		return res
	}
	res.Status = resultset.StatusCompleted
	return res
}
