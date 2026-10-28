package checks

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

const (
	kubernetesID = "repository.kubernetes"

	reasonChartNotRendered      = "chart_not_rendered"
	reasonKubernetesSchemasGone = "kubernetes_schemas_unavailable"

	// toolKubernetesSchemas is the name of the Context tool that carries the
	// Kubernetes version into the Benchmark fingerprint.
	toolKubernetesSchemas = "kubernetes-schemas"
)

func init() { Register(kubernetesID, kubernetesCheck{}) }

// kubernetesCheck validates Kubernetes resources with kubeconform, offline,
// against the schemas of one pinned Kubernetes version: every resource each
// Helm chart renders, with each values file (the rendering is shared with
// repository.helm), and every plain manifest of the project. A resource that
// kubeconform reports as invalid is a Gate. Kinds without a schema, such as
// custom resources, are not validated and are named in one Limitation.
//
// kubeconform runs in its official image with the Snapshot read-only and no
// network. The schemas come from a cache volume that the Preparation phase
// fetched and verified, and the rendered manifests are copied into the
// container as files.
type kubernetesCheck struct{}

func (kubernetesCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.kubernetes examines the whole project, not one package"
	}
	if len(helmCharts(p)) == 0 {
		if manifests, tooLarge := kubernetesManifests(p); len(manifests)+len(tooLarge) == 0 {
			return resultset.NotApplicable, "the project has no Helm chart and no YAML file with a top-level apiVersion and kind outside node_modules, Test data and Build output"
		}
	}
	return resultset.Applicable, ""
}

// Images are kubeconform's, and Alpine's for the charts' rendering and for the
// Preparation phase's schema fetch.
func (kubernetesCheck) Images(c *discovery.Context) []string {
	if c.Package != nil {
		return nil
	}
	return []string{toolset.Kubeconform.Image.Ref(), toolset.Alpine.Ref()}
}

// UsesToolset says that the Helm binary comes from the toolset volume.
func (kubernetesCheck) UsesToolset(c *discovery.Context) bool { return c.Package == nil }

// UsesKubernetesSchemas says that the Kubernetes schemas come from their cache
// volume.
func (kubernetesCheck) UsesKubernetesSchemas(c *discovery.Context) bool { return c.Package == nil }

// kubeconformBase is the command up to the files. The schema location is a
// local template, so the Check never reaches a network.
func kubeconformBase() []string {
	return []string{
		"/kubeconform", "-strict", "-verbose", "-output", "json", "-ignore-missing-schemas",
		"-kubernetes-version", toolset.KubernetesVersion,
		"-schema-location", toolvolume.KubernetesSchemaMountPath + "/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json",
	}
}

// kubeFile is one file for kubeconform: a plain manifest of the Snapshot, or
// the manifests one template rendered.
type kubeFile struct {
	file    string // where the container finds it
	content []byte // set for rendered manifests, which are copied in
	source  kubeSource
}

func (kubernetesCheck) Run(ctx context.Context, in *Input) *Result {
	schemas := toolset.KubernetesVersion
	res := &Result{
		ToolRefs:     []resultset.ToolRef{toolRef(toolset.Kubeconform)},
		ContextTools: []resultset.ToolRef{{Name: toolKubernetesSchemas, Version: schemas}},
	}
	if in.KubernetesSchemaVolume == "" {
		res.Status, res.ReasonCode = resultset.StatusInfrastructureError, reasonKubernetesSchemasGone
		res.Reason = "the Preparation phase did not provide the Kubernetes schemas"
		if in.KubernetesSchemaError != "" {
			res.Reason = "the Kubernetes schemas could not be prepared: " + in.KubernetesSchemaError
		}
		return res
	}

	charts := helmCharts(in.Project)
	manifests, tooLarge := kubernetesManifests(in.Project)
	var inputs []kubeFile
	for _, rel := range manifests {
		inputs = append(inputs, kubeFile{file: snapshotPath(rel), source: kubeSource{Path: rel}})
	}

	if len(charts) > 0 {
		if in.ToolsetVolume == "" {
			unavailable := in.toolsetUnavailable("the Helm binary")
			unavailable.ToolRefs, unavailable.ContextTools = res.ToolRefs, res.ContextTools
			return unavailable
		}
		rendered := renderHelmCharts(ctx, in)
		if rendered.Err != nil {
			return failedToRun(res, rendered.Err)
		}
		if f := rendered.Failed; f != nil {
			res.Status, res.ReasonCode = resultset.StatusToolError, "tool_failed"
			res.Reason = fmt.Sprintf("helm exited with %d: %s", f.ExitCode, tail(f.Stderr, 400))
			return res
		}
		chartInputs, left := renderedInputs(in, charts, rendered)
		inputs = append(inputs, chartInputs...)
		res.Limitations = append(res.Limitations, left...)
	}
	res.Limitations = append(res.Limitations, tooLargeLimitation(kubernetesID, tooLarge)...)

	analysis := newKubeAnalysis()
	if len(inputs) > 0 {
		files := make([]string, len(inputs))
		for i, input := range inputs {
			files[i] = input.file
		}
		res.Command = recordedCommand(kubeconformBase(), files)
		ok := runChunks(ctx, in, res, toolset.Kubeconform, inputs,
			func(n int, chunk []kubeFile) docker.ContainerSpec {
				cmd := kubeconformBase()[1:] // the image's entrypoint is /kubeconform
				var copies []docker.File
				for _, input := range chunk {
					cmd = append(cmd, input.file)
					if input.content != nil {
						copies = append(copies, docker.File{Path: input.file, Mode: 0o644, Content: input.content})
					}
				}
				spec := toolContainer(in, fmt.Sprintf("kubeconform-%d", n), toolset.Kubeconform, cmd, "", nil, copies...)
				spec.Mounts = append(spec.Mounts, docker.Mount{Volume: in.KubernetesSchemaVolume, Path: toolvolume.KubernetesSchemaMountPath, ReadOnly: true})
				return spec
			},
			func(chunk []kubeFile, stdout []byte) error {
				sources := map[string]kubeSource{}
				for _, input := range chunk {
					sources[input.file] = input.source
				}
				return analysis.add(sources, stdout)
			})
		if !ok {
			return res
		}
	}

	res.Findings = analysis.findings(in)
	sort.SliceStable(res.Findings, func(i, j int) bool {
		return res.Findings[i].Locations[0].Path < res.Findings[j].Locations[0].Path
	})
	res.Limitations = append(res.Limitations, analysis.limitations()...)
	res.Status = resultset.StatusCompleted
	return res
}

// renderedInputs turns what the charts rendered into files for kubeconform, one
// per template and values file. A chart that Helm cannot render, or whose
// dependencies are not vendored, is left out with a Limitation: repository.helm
// reports why.
func renderedInputs(in *Input, charts []helmChart, rendered *helmRendering) ([]kubeFile, []resultset.Limitation) {
	var inputs []kubeFile
	var limitations []resultset.Limitation
	leftOut := func(chart helmChart, what, why string) {
		at, id := chart.file("Chart.yaml"), kubernetesID
		limitations = append(limitations, resultset.Limitation{
			ReasonCode: reasonChartNotRendered, CheckID: &id, Path: &at,
			Message: fmt.Sprintf("the chart in %s was left out %s, because %s; repository.helm reports it", shownPath(chart.Dir), what, why),
		})
	}
	n := 0
	for _, chart := range charts {
		if len(chart.Missing) > 0 {
			leftOut(chart, "entirely", "its dependencies are not vendored under charts/ ("+shownDependencies(chart.Missing)+") and Helm cannot download them without network access")
			continue
		}
		for _, values := range append([]string{""}, chart.Values...) {
			r := rendered.lookup(chart.Dir, values)
			switch {
			case r == nil:
				continue
			case r.ExitCode != 0:
				what := "with its default values"
				if values != "" {
					what = "with the values file " + shownPath(values)
				}
				leftOut(chart, what, "helm template failed")
				continue
			}
			for _, tpl := range splitRendered(r.Stdout) {
				n++
				inputs = append(inputs, kubeFile{
					file:    fmt.Sprintf("/render/%d.yaml", n),
					content: []byte(tpl.Content),
					source: kubeSource{
						Path:  chartFileOrChartYaml(in, chart.Dir, tpl.Name),
						Chart: chart.Dir, Template: templateLabel(tpl.Name), Values: values,
					},
				})
			}
		}
	}
	return inputs, limitations
}

// shownDependencies lists dependency names from a Chart.yaml for trusted text,
// with a placeholder for a name that does not look like a name.
func shownDependencies(names []string) string {
	shown := make([]string, len(names))
	for i, n := range names {
		shown[i] = shownWord(n, "dependency name")
	}
	return strings.Join(shown, ", ")
}

// templateLabel is how a Finding names a template that Helm gave no source for.
func templateLabel(name string) string {
	if name == "" {
		return "(unknown template)"
	}
	return name
}
