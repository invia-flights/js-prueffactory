package checks

import (
	"context"
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

const composeID = "repository.compose"

func init() { Register(composeID, composeCheck{}) }

// composeCheck validates every compose set of the project root with
// `docker compose config -q`, the way compose merges the files of a set. The
// project's .env file is read, because the Snapshot is the working directory,
// and no environment variable of the host is passed. A set that compose
// rejects is a Gate, unless the only trouble is a variable without a value:
// that is a warning, so a variable that a CI system sets does not fail the Run.
//
// compose runs in the official Docker CLI image, which holds the compose
// plugin and needs no daemon, with the Snapshot read-only on the Run's
// internal network. A set with a remote `include:` cannot be resolved offline
// and is not run: it is a Limitation, and the Check is partial.
type composeCheck struct{}

func (composeCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.compose examines the whole project, not one package"
	}
	if len(composeSets(p)) == 0 {
		return resultset.NotApplicable, "the project root has no compose file (compose.yaml, docker-compose.yml and the like)"
	}
	return resultset.Applicable, ""
}

func (composeCheck) Images(c *discovery.Context) []string {
	return projectImages(c, toolset.DockerCLI)
}

// composeCommand is the command that validates one set. Every path starts with
// a slash, so none can read as an option.
func composeCommand(files []string) []string {
	cmd := []string{"docker", "compose"}
	for _, f := range files {
		cmd = append(cmd, "-f", snapshotPath(f))
	}
	return append(cmd, "config", "-q")
}

func (composeCheck) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: []resultset.ToolRef{toolRef(toolset.DockerCLI)}}
	res.Command = composeCommand([]string{"<file>"})

	sets := composeSets(in.Project)
	notRun, worst := 0, 0
	for n, set := range sets {
		if remote := composeRemoteIncludes(in, set); len(remote) > 0 {
			notRun++
			for _, r := range remote {
				res.Limitations = append(res.Limitations, composeIncludeLimitation(set, r))
			}
			continue
		}
		spec := toolContainer(in, fmt.Sprintf("compose-%d", n+1), toolset.DockerCLI, composeCommand(set.Files), snapshotMount, nil)
		c, err := in.Docker.RunContainer(ctx, spec)
		if err != nil {
			return failedToRun(res, err)
		}
		worst = max(worst, c.ExitCode)
		res.Tool = toolInfo(toolset.DockerCLI, worst)
		if c.ExitCode > 1 {
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_failed"
			res.Reason = fmt.Sprintf("docker compose exited with %d: %s", c.ExitCode, tail(string(c.Stderr), 400))
			return res
		}
		res.Findings = append(res.Findings, composeSetFindings(in, set, c.ExitCode, string(c.Stderr))...)
	}

	if notRun > 0 {
		res.Status, res.ReasonCode = resultset.StatusPartial, reasonIncludeNotResolved
		res.Reason = fmt.Sprintf("%d of %d compose sets have a remote include that cannot be resolved offline, so they were not validated", notRun, len(sets))
		return res
	}
	res.Status = resultset.StatusCompleted
	return res
}

func composeIncludeLimitation(set composeSet, r composeRemote) resultset.Limitation {
	value := shownURL(r.Value, "include")
	return resultset.Limitation{
		ReasonCode: reasonIncludeNotResolved,
		Message: fmt.Sprintf("the compose set %s includes the remote source %s, which cannot be fetched without network access, so the set was not validated",
			composeSetLabel(set), value),
		CheckID: strPointer(composeID), Path: strPointer(r.File),
	}
}
