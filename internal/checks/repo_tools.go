package checks

import (
	"context"
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// Shared pieces of the Checks that run one pinned tool image over repository
// files: repository.dockerfile, repository.shell and api.lint.

// filesPerContainer bounds the number of file arguments of one tool container.
const filesPerContainer = 100

// maxRecordedFiles bounds the file arguments shown in a recorded command.
const maxRecordedFiles = 20

// toolRef records a pinned tool in the Context it ran in.
func toolRef(t toolset.PinnedTool) resultset.ToolRef {
	digest := t.Image.Digest
	return resultset.ToolRef{Name: t.Name, Version: t.Version, Digest: &digest}
}

// toolInfo is the Execution's tool entry.
func toolInfo(t toolset.PinnedTool, exitCode int) *resultset.Tool {
	version := t.Version
	return &resultset.Tool{Name: t.Name, Version: &version, ExitCode: &exitCode}
}

// projectImages is the Images answer of project Checks that run one tool.
func projectImages(c *discovery.Context, t toolset.PinnedTool) []string {
	if c.Package != nil {
		return nil
	}
	return []string{t.Image.Ref()}
}

func chunks[T any](items []T, size int) [][]T {
	var out [][]T
	for len(items) > size {
		out = append(out, items[:size])
		items = items[size:]
	}
	if len(items) > 0 {
		out = append(out, items)
	}
	return out
}

// snapshotPath is the absolute path of a project file inside a tool container.
// It always starts with a slash, so a file name can never read as an option.
func snapshotPath(rel string) string { return snapshotMount + "/" + rel }

// recordedCommand is the command as the Report shows it: long file lists are
// cut.
func recordedCommand(base, files []string) []string {
	cmd := append([]string{}, base...)
	if len(files) > maxRecordedFiles {
		cmd = append(cmd, files[:maxRecordedFiles]...)
		return append(cmd, fmt.Sprintf("... (%d more files)", len(files)-maxRecordedFiles))
	}
	return append(cmd, files...)
}

// toolContainer is the container a repository tool runs in: the Snapshot
// read-only at /snapshot, the Run's internal network, the standard limits and
// no variables of the host.
func toolContainer(in *Input, name string, t toolset.PinnedTool, cmd []string, workDir string, env map[string]string, files ...docker.File) docker.ContainerSpec {
	return docker.ContainerSpec{
		Name:    name,
		Image:   t.Image.Ref(),
		Cmd:     cmd,
		Env:     env,
		WorkDir: workDir,
		Network: in.Network,
		Mounts:  []docker.Mount{{Volume: in.SnapshotVolume, Path: snapshotMount, ReadOnly: true}},
		Files:   files,
	}
}

// runChunks runs one container per chunk of files and collects stdout. A tool
// that fails to start, or exits with a code outside okExit, ends the Check with
// a Result that says so.
func runChunks[T any](ctx context.Context, in *Input, res *Result, t toolset.PinnedTool, items []T,
	spec func(n int, chunk []T) docker.ContainerSpec,
	handle func(chunk []T, stdout []byte) error) bool {
	worst := 0
	for n, chunk := range chunks(items, filesPerContainer) {
		c, err := in.Docker.RunContainer(ctx, spec(n+1, chunk))
		if err != nil {
			failedToRun(res, err)
			return false
		}
		if c.ExitCode > worst {
			worst = c.ExitCode
		}
		res.Tool = toolInfo(t, worst)
		if c.ExitCode > 1 {
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_failed"
			res.Reason = fmt.Sprintf("%s exited with %d: %s", t.Name, c.ExitCode, tail(string(c.Stderr), 400))
			return false
		}
		if err := handle(chunk, c.Stdout); err != nil {
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_output_unreadable"
			res.Reason = fmt.Sprintf("%v (exit %d): %s", err, c.ExitCode, tail(string(c.Stderr), 400))
			return false
		}
	}
	return true
}
