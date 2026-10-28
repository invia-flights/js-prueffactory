package docker

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// SweepLeftovers removes the containers, networks and volumes that dead Runs
// left behind. A resource of another Run is removed when its deadline has
// passed, or when it comes from host and its process ID no longer runs.
// Resources of live Runs, cache volumes (they carry no run label) and anything
// that is not ours are never touched, and neither is a resource of the Run this
// Driver belongs to.
//
// pidAlive may be nil; ProcessRunning is used then. It returns what was removed.
func (d *Driver) SweepLeftovers(ctx context.Context, now time.Time, host string, pidAlive func(pid int) bool) ([]string, error) {
	if pidAlive == nil {
		pidAlive = ProcessRunning
	}
	label := func(key string) string { return `{{.Label "` + key + `"}}` }
	fields := strings.Join([]string{label(LabelRunID), label(LabelHost), label(LabelPID), label(LabelDeadline)}, "|")
	// Containers go first, because a container can hold on to a volume.
	kinds := []struct {
		name string
		list []string
		rm   []string
	}{
		{"container", []string{"ps", "--all", "--filter", "label=" + LabelRunID, "--format", "{{.ID}}|" + fields}, []string{"rm", "--force", "--volumes"}},
		{"network", []string{"network", "ls", "--filter", "label=" + LabelRunID, "--format", "{{.ID}}|" + fields}, []string{"network", "rm"}},
		{"volume", []string{"volume", "ls", "--filter", "label=" + LabelRunID, "--format", "{{.Name}}|" + fields}, []string{"volume", "rm", "--force"}},
	}
	var removed []string
	var errs []error
	for _, k := range kinds {
		out, err := d.output(ctx, nil, k.list...)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		var doomed []string
		for _, line := range strings.Split(string(out), "\n") {
			parts := strings.Split(strings.TrimSpace(line), "|")
			if len(parts) != 5 || parts[0] == "" {
				continue
			}
			id, owner := parts[0], resourceOwner{runID: parts[1], host: parts[2], deadline: parts[4]}
			owner.pid, _ = strconv.Atoi(parts[3])
			if owner.runID == d.scope.RunID {
				continue
			}
			if owner.abandoned(now, host, pidAlive) {
				doomed = append(doomed, id)
			}
		}
		if len(doomed) == 0 {
			continue
		}
		// One by one: a concurrent Run's sweep may already have removed some of
		// them, and a single failing id must not hide what the rest did.
		for _, id := range doomed {
			if _, err := d.output(ctx, nil, append(append([]string{}, k.rm...), id)...); err != nil {
				if goneAlready(err) {
					continue
				}
				errs = append(errs, fmt.Errorf("removing leftover %s %s: %w", k.name, id, err))
				continue
			}
			removed = append(removed, id)
		}
	}
	return removed, errors.Join(errs...)
}

// resourceOwner is what the labels of a resource say about the Run behind it.
type resourceOwner struct {
	runID, host, deadline string
	pid                   int
}

// abandoned reports whether the Run behind the resource is dead: its deadline
// has passed, or it ran on this host under a process ID that no longer runs.
// Labels that cannot be read never make a resource look abandoned on their own;
// without a readable deadline only the process check applies.
func (o resourceOwner) abandoned(now time.Time, host string, pidAlive func(int) bool) bool {
	if dl, err := time.Parse(time.RFC3339, o.deadline); err == nil && now.After(dl) {
		return true
	}
	return o.host == host && o.pid > 0 && !pidAlive(o.pid)
}

// ProcessRunning reports whether a process with the given ID exists. A process
// that belongs to another user still counts as running.
func ProcessRunning(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// goneAlready reports whether a failed removal only says the resource no
// longer exists, which is what a concurrent sweep leaves behind.
func goneAlready(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "No such") || strings.Contains(msg, "not found")
}
