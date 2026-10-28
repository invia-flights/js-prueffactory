package checks

import (
	"context"
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func init() { Register("repository.shell", shellCheck{}) }

// shellCheck runs ShellCheck on shell scripts, once per dialect. Error-level
// results are Gates. The project's own .shellcheckrc is not read, so the
// result does not depend on a configuration the project controls; inline
// directives keep working.
type shellCheck struct{}

func (shellCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.shell examines the whole project, not one package"
	}
	if len(shellTargets(p)) == 0 {
		return resultset.NotApplicable, "the project has no shell script outside node_modules and Test data"
	}
	return resultset.Applicable, ""
}

func (shellCheck) Images(c *discovery.Context) []string {
	return projectImages(c, toolset.ShellCheck)
}

func (shellCheck) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: []resultset.ToolRef{toolRef(toolset.ShellCheck)}}

	byDialect := map[string][]string{}
	for _, s := range shellTargets(in.Project) {
		byDialect[s.Dialect] = append(byDialect[s.Dialect], snapshotPath(s.Path))
	}
	dialects := make([]string, 0, len(byDialect))
	for d := range byDialect {
		dialects = append(dialects, d)
	}
	sort.Strings(dialects)

	for i, dialect := range dialects {
		base := []string{"--norc", "-f", "json1", "-s", dialect}
		paths := byDialect[dialect]
		if i == 0 {
			res.Command = recordedCommand(append([]string{"shellcheck"}, base...), paths)
		}
		ok := runChunks(ctx, in, res, toolset.ShellCheck, paths,
			func(n int, chunk []string) docker.ContainerSpec {
				cmd := append(append([]string{}, base...), chunk...)
				return toolContainer(in, fmt.Sprintf("shellcheck-%s-%d", dialect, n), toolset.ShellCheck, cmd, "", nil)
			},
			func(_ []string, stdout []byte) error {
				found, err := shellcheckFindings(in, stdout)
				res.Findings = append(res.Findings, found...)
				return err
			})
		if !ok {
			return res
		}
	}
	res.Status = resultset.StatusCompleted
	return res
}
