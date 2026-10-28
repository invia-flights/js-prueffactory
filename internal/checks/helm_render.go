package checks

import (
	"context"
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// This file is the rendering step that repository.helm and repository.kubernetes
// share: `helm template` of every chart whose dependencies are vendored, once
// with the default values and once per extra values file. Whichever Check asks
// first renders; the other reuses the result, so a Run renders each chart once.

// helmRenderKey is the key of the rendering in the Run's Shared store.
const helmRenderKey = "helm.render"

// helmRender is what one `helm template` run printed.
type helmRender struct {
	Chart helmChart
	// Values is the values file of the chart folder, or "" for the defaults.
	Values   string
	ExitCode int
	Stdout   string
	Stderr   string
}

// helmRendering is the result of rendering every chart of the project.
type helmRendering struct {
	// Renders holds one entry per chart and values file, in chart order with
	// the default values first. A chart with unvendored dependencies has none.
	Renders []helmRender
	// Worst is the highest exit code of any Helm run.
	Worst int
	// Failed is the run that ended the rendering because Helm exited with a
	// code above 1, which is a failure of the tool and not of the chart.
	Failed *helmRender
	// Err is why a container could not run at all. Nothing after it was tried.
	Err error
}

// helmRunner starts one Helm container and returns what it left behind.
type helmRunner func(ctx context.Context, cmd []string) (*docker.ContainerResult, error)

// renderHelmCharts renders the charts of the project in the toolset volume's
// Helm, with the Snapshot read-only and no network.
func renderHelmCharts(ctx context.Context, in *Input) *helmRendering {
	n := 0
	return sharedHelmRender(ctx, in, func(ctx context.Context, cmd []string) (*docker.ContainerResult, error) {
		n++
		spec := toolContainer(in, fmt.Sprintf("helm-render-%d", n), toolset.HelmRunner, cmd, "", helmEnv)
		spec.Mounts = append(spec.Mounts, docker.Mount{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true})
		return in.Docker.RunContainer(ctx, spec)
	})
}

// sharedHelmRender returns the rendering of the Run, making it with run when
// no Check has yet. A rendering made under a context that ended is not kept.
func sharedHelmRender(ctx context.Context, in *Input, run helmRunner) *helmRendering {
	render := func(ctx context.Context) (any, bool) {
		return doHelmRender(ctx, in, run), ctx.Err() == nil
	}
	if in.Shared == nil {
		v, _ := render(ctx)
		return v.(*helmRendering)
	}
	return in.Shared.Do(ctx, helmRenderKey, render).(*helmRendering)
}

func doHelmRender(ctx context.Context, in *Input, run helmRunner) *helmRendering {
	out := &helmRendering{}
	for _, chart := range helmCharts(in.Project) {
		if len(chart.Missing) > 0 {
			continue
		}
		for _, values := range append([]string{""}, chart.Values...) {
			c, err := run(ctx, helmTemplateCommand(chart.Dir, values))
			if err != nil {
				out.Err = err
				return out
			}
			r := helmRender{Chart: chart, Values: values, ExitCode: c.ExitCode, Stdout: string(c.Stdout), Stderr: string(c.Stderr)}
			out.Worst = max(out.Worst, c.ExitCode)
			if c.ExitCode > 1 {
				out.Failed = &r
				return out
			}
			out.Renders = append(out.Renders, r)
		}
	}
	return out
}

// lookup returns the render of a chart folder with a values file ("" for the
// defaults), or nil when there is none.
func (h *helmRendering) lookup(dir, values string) *helmRender {
	for i := range h.Renders {
		if r := &h.Renders[i]; r.Chart.Dir == dir && r.Values == values {
			return r
		}
	}
	return nil
}
