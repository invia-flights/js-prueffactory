package engine

import (
	"context"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

// makeWorkingCopy creates the Working copy: a second run-owned volume holding a
// writable copy of the Snapshot, where dependencies are installed. The copy is
// made inside Docker from the Snapshot volume, so the Snapshot reaches Docker
// only once and no container ever mounts a host path (ADR-0001). The Snapshot
// volume itself stays as it was, read-only for every Check that examines the
// project's own files. node_modules lives only in the Working copy, and the
// volume goes away with the Run.
func (r *run) makeWorkingCopy(ctx context.Context, image string) error {
	drv := r.cfg.Docker
	r.log.Printf("creating the Working copy")
	volume, err := drv.CreateVolume(ctx, "work")
	if err != nil {
		return err
	}
	res, err := drv.RunContainer(ctx, docker.ContainerSpec{
		Name: "workcopy", Image: image, Network: docker.NetworkNone,
		// -a keeps the executable bit and relative symlinks as they are.
		Cmd: []string{"cp", "-a", "/snapshot/.", "/work/"},
		Mounts: []docker.Mount{
			{Volume: r.volume, Path: "/snapshot", ReadOnly: true},
			{Volume: volume, Path: "/work"},
		},
	})
	if err != nil {
		return fmt.Errorf("cannot create the Working copy: %w", err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("cannot create the Working copy: cp exited with %d: %s", res.ExitCode, strings.TrimSpace(string(res.Stderr)))
	}
	r.workVolume = volume
	return nil
}
