package engine

import (
	"context"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// kubernetesSchemas is what the Preparation phase made of the Kubernetes
// schemas.
type kubernetesSchemas struct {
	volume string
	// err is why the schemas are not available, when they are not.
	err string
}

// needsKubernetesSchemas says whether any Check execution that will run
// validates with the Kubernetes schemas.
func (r *run) needsKubernetesSchemas() bool {
	for _, p := range r.planned {
		if !p.runnable() {
			continue
		}
		if u, ok := p.check.(checks.KubernetesSchemaUser); ok && u.UsesKubernetesSchemas(p.context) {
			return true
		}
	}
	return false
}

// prepareKubernetesSchemas makes the schemas of the pinned Kubernetes version
// available to the Execution phase: it fetches them when the volume lacks them
// or holds a file that no longer matches its checksum, and otherwise reuses
// them. A failure does not stop the Run: the Checks that need the schemas end
// as infrastructure_error with the reason, and every other Check goes on. Only
// a cancelled Run returns an error.
func (r *run) prepareKubernetesSchemas(ctx context.Context) error {
	if !r.needsKubernetesSchemas() {
		return nil
	}
	// The Alpine image is pulled with the Checks' images.
	schemas, err := toolvolume.EnsureKubernetesSchemas(ctx, toolvolume.KubernetesSchemasConfig{
		Docker: r.cfg.Docker, CacheDir: r.cfg.CacheDir, Helper: toolset.Alpine.Ref(),
		Logf: r.log.Printf,
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.log.Printf("Kubernetes schema preparation failed: %v", err)
		r.kubernetesSchemas = kubernetesSchemas{err: err.Error()}
		return nil
	}
	r.kubernetesSchemas = kubernetesSchemas{volume: schemas.Name}
	return nil
}
