package engine

import (
	"context"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// needsToolset says whether any Check execution that will run mounts the
// toolset volume.
func (r *run) needsToolset() bool {
	for _, p := range r.planned {
		if !p.runnable() {
			continue
		}
		if u, ok := p.check.(checks.ToolsetUser); ok && u.UsesToolset(p.context) {
			return true
		}
	}
	return false
}

// prepareToolset makes the toolset volume available to the Execution phase: it
// installs the pinned npm tools once per toolset version and reuses them in
// later Runs. A failure does not stop the Run: the Checks that need the tools
// end as infrastructure_error with the reason, and every other Check goes on.
// Only a cancelled Run returns an error.
func (r *run) prepareToolset(ctx context.Context) error {
	if !r.needsToolset() {
		return nil
	}
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	vol, err := toolvolume.Ensure(ctx, toolvolume.Config{
		Docker: r.cfg.Docker, CacheDir: r.cfg.CacheDir, Image: img.Ref(),
		Logf: r.log.Printf,
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.log.Printf("toolset preparation failed: %v", err)
		r.toolsetErr = err.Error()
		return nil
	}
	r.toolsetVolume = vol.Name
	return nil
}

// recordContextTools adds the tools that Checks reported to the Context they
// ran in, once per tool.
func recordContextTools(contexts []resultset.Context, results []*execResult) {
	for _, res := range results {
		for i := range contexts {
			if contexts[i].ID != res.p.context.ID {
				continue
			}
			for _, tool := range res.contextTools {
				seen := false
				for _, have := range contexts[i].Tools {
					seen = seen || (have.Name == tool.Name && have.Version == tool.Version)
				}
				if !seen {
					contexts[i].Tools = append(contexts[i].Tools, tool)
				}
			}
		}
	}
}
