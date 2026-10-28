package checks

import (
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// toolsetUnavailable is the Result of a Check whose tool could not be put into
// the toolset volume. Every Check that mounts the volume starts with
// `if in.ToolsetVolume == ""` and returns this.
func (in *Input) toolsetUnavailable(tool string) *Result {
	return &Result{
		Status: resultset.StatusInfrastructureError, ReasonCode: "toolset_unavailable",
		Reason: "the toolset volume with " + tool + " could not be prepared: " + in.ToolsetError,
	}
}

// helperFailed marks res as the Result of an embedded helper script that did
// not leave usable output: it exited with an error, or printed something that
// is not its JSON document. tailLen is how much of its stderr goes into the
// Reason.
func helperFailed(res *Result, helper string, c *docker.ContainerResult, tailLen int) *Result {
	res.Status, res.ReasonCode = resultset.StatusToolError, "helper_failed"
	res.Reason = fmt.Sprintf("the %s helper exited with %d: %s", helper, c.ExitCode, tail(string(c.Stderr), tailLen))
	if c.OOMKilled {
		res.Reason = "the " + helper + " helper ran out of memory: " + res.Reason
	}
	return res
}
