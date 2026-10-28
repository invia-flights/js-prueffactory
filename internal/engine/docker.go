package engine

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// prepare is the Preparation phase for the Execution phase's containers: it
// pulls the pinned images, streams the Snapshot into a run-owned volume as a tar
// stream (ADR-0001), and creates the Run's internal network (ADR-0004). It does
// nothing when no planned Check needs a container.
func (r *run) prepare(ctx context.Context) error {
	images := map[string]bool{}
	workImage := "" // an image to make the Working copy with, when a Check uses it
	for _, p := range r.planned {
		if !p.runnable() {
			continue
		}
		if u, ok := p.check.(checks.ImageUser); ok {
			for _, img := range u.Images(p.context) {
				images[img] = true
				if w, ok := p.check.(checks.WorkingCopyUser); ok && w.UsesWorkingCopy() && (workImage == "" || img < workImage) {
					workImage = img
				}
			}
		}
	}
	if len(images) == 0 {
		return nil
	}
	for _, img := range r.serviceImages() {
		images[img] = true
	}
	refs := make([]string, 0, len(images))
	for img := range images {
		refs = append(refs, img)
	}
	sort.Strings(refs)

	drv := r.cfg.Docker
	if drv == nil {
		return errors.New("no Docker driver is configured")
	}
	for _, ref := range refs {
		r.log.Printf("preparing image %s", ref)
		if err := drv.Pull(ctx, ref); err != nil {
			return err
		}
	}
	var err error
	r.log.Printf("streaming the Snapshot into a Docker volume")
	if r.volume, err = drv.CreateVolume(ctx, "snapshot"); err != nil {
		return err
	}
	if err := drv.PutTar(ctx, r.volume, refs[0], r.snap.WriteTar); err != nil {
		return fmt.Errorf("cannot stream the Snapshot into Docker: %w", err)
	}
	if workImage != "" {
		if err := r.makeWorkingCopy(ctx, workImage); err != nil {
			return err
		}
	}
	if r.network, err = drv.CreateNetwork(ctx, "net", true); err != nil {
		return err
	}
	if err := r.prepareToolset(ctx); err != nil {
		return err
	}
	if err := r.prepareAdvisoryDB(ctx); err != nil {
		return err
	}
	if err := r.prepareKubernetesSchemas(ctx); err != nil {
		return err
	}
	// The Execution phase starts here: its first step proves the network is closed.
	r.probeIsolation(ctx)
	r.dockerReady = true
	return nil
}
