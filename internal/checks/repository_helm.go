package checks

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

const helmID = "repository.helm"

func init() { Register(helmID, helmCheck{}) }

// helmCheck lints and renders every Helm chart outside node_modules and Test
// data: `helm lint --strict`, then `helm template` once with the default values
// and once per extra values file of the chart folder. A chart that does not
// render is a Gate. Lint errors are errors without a Gate, lint warnings are
// warnings. A chart whose dependencies are not vendored under charts/ is
// blocked, because Helm would have to download them.
//
// The Helm binary comes from the toolset volume and runs in the pinned Alpine
// image, with the Snapshot read-only and no network.
type helmCheck struct{}

// maxChartYamlBytes is the size above which Chart.yaml and requirements.yaml
// are not read to look for dependencies.
const maxChartYamlBytes = 1 << 20

const reasonDependenciesNotVendored = "chart_dependencies_not_vendored"

// helmChart is a chart folder and what is known about it without running Helm.
type helmChart struct {
	Dir string // project-relative, "." for the project root
	// Values are the names of the extra `values*.yaml` files in the chart
	// folder: every one but values.yaml itself, which is the default.
	Values []string
	// Missing are the names of dependencies that are not vendored under charts/.
	Missing []string
}

// file is the project-relative path of a file in the chart folder.
func (c helmChart) file(name string) string {
	if c.Dir == "." {
		return name
	}
	return c.Dir + "/" + name
}

// templatesPrefix is the project-relative path of the chart's templates folder
// with a trailing slash, the prefix of every template file.
func (c helmChart) templatesPrefix() string {
	return c.file("templates") + "/"
}

// helmCharts returns every folder with a Chart.yaml, in path order.
func helmCharts(p *discovery.Project) []helmChart {
	files := map[string]bool{}
	for _, f := range p.Files {
		files[f.Path] = true
	}
	var charts []helmChart
	for _, f := range candidates(p) {
		if path.Base(f.Path) != "Chart.yaml" {
			continue
		}
		dir := path.Dir(f.Path)
		c := helmChart{Dir: dir}
		for _, g := range candidates(p) {
			name := path.Base(g.Path)
			if path.Dir(g.Path) == dir && name != "values.yaml" && strings.HasPrefix(name, "values") && strings.HasSuffix(name, ".yaml") {
				c.Values = append(c.Values, name)
			}
		}
		sort.Strings(c.Values)
		c.Missing = unvendoredDependencies(p.Root, c, files)
		charts = append(charts, c)
	}
	sort.Slice(charts, func(i, j int) bool { return charts[i].Dir < charts[j].Dir })
	return charts
}

// unvendoredDependencies returns the dependencies that the chart declares
// (Chart.yaml for apiVersion v2, requirements.yaml before) and that are neither
// an archive `charts/<name>-<version>.tgz` nor a folder `charts/<name>/`. A
// file that is too large or does not parse declares nothing: Helm reports that
// itself.
func unvendoredDependencies(root string, c helmChart, files map[string]bool) []string {
	var meta struct {
		APIVersion   string `yaml:"apiVersion"`
		Dependencies []struct {
			Name string `yaml:"name"`
		} `yaml:"dependencies"`
	}
	if !readYAML(root, c.file("Chart.yaml"), &meta) {
		return nil
	}
	deps := meta.Dependencies
	if meta.APIVersion != "v2" {
		var req struct {
			Dependencies []struct {
				Name string `yaml:"name"`
			} `yaml:"dependencies"`
		}
		deps = nil
		if readYAML(root, c.file("requirements.yaml"), &req) {
			deps = req.Dependencies
		}
	}
	var missing []string
	for _, d := range deps {
		if !vendored(c, d.Name, files) {
			missing = append(missing, d.Name)
		}
	}
	return missing
}

// readYAML decodes a regular file of the Snapshot that is not too large.
func readYAML(root, rel string, into any) bool {
	f, ok := openRegular(root, rel)
	if !ok {
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxChartYamlBytes+1))
	if err != nil || len(data) > maxChartYamlBytes {
		return false
	}
	return yaml.Unmarshal(data, into) == nil
}

var versionStart = regexp.MustCompile(`^v?[0-9]`)

// vendored says whether charts/ holds the dependency as an archive or a folder.
func vendored(c helmChart, name string, files map[string]bool) bool {
	if name == "" || strings.ContainsAny(name, `/\`) {
		return false
	}
	if files[c.file("charts/"+name+"/Chart.yaml")] {
		return true
	}
	prefix := c.file("charts/" + name + "-")
	for f := range files {
		if rest, ok := strings.CutPrefix(f, prefix); ok && strings.HasSuffix(rest, ".tgz") && !strings.Contains(rest, "/") && versionStart.MatchString(rest) {
			return true
		}
	}
	return false
}

func (helmCheck) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "repository.helm examines the whole project, not one package"
	}
	if len(helmCharts(p)) == 0 {
		return resultset.NotApplicable, "the project has no Helm chart (a folder with a Chart.yaml) outside node_modules and Test data"
	}
	return resultset.Applicable, ""
}

func (helmCheck) Images(c *discovery.Context) []string {
	return projectImages(c, toolset.HelmRunner)
}

// UsesToolset says that the Helm binary comes from the toolset volume.
func (helmCheck) UsesToolset(c *discovery.Context) bool { return c.Package == nil }

// helmToolRefs records the Helm release and the image it ran in.
func helmToolRefs() []resultset.ToolRef {
	digest := toolset.Alpine.Digest
	return []resultset.ToolRef{
		{Name: toolset.HelmRunner.Name, Version: toolset.Helm.Version},
		{Name: "alpine", Version: toolset.Alpine.Tag, Digest: &digest},
	}
}

// chartPath is the absolute path of a chart folder inside a Helm container.
func chartPath(dir string) string {
	if dir == "." {
		return snapshotMount
	}
	return snapshotPath(dir)
}

func helmLintCommand(dir string) []string {
	return []string{toolvolume.HelmBin, "lint", "--strict", chartPath(dir)}
}

// helmTemplateCommand renders a chart with its default values, or with one
// values file of its folder. Every path starts with a slash, so none can read
// as an option.
func helmTemplateCommand(dir, values string) []string {
	cmd := []string{toolvolume.HelmBin, "template", "jspf", chartPath(dir)}
	if values != "" {
		cmd = append(cmd, "-f", chartPath(dir)+"/"+values)
	}
	return cmd
}

// helmEnv keeps Helm's cache and config in the container's own /tmp.
var helmEnv = map[string]string{
	"HOME":             "/tmp",
	"HELM_CACHE_HOME":  "/tmp/helm/cache",
	"HELM_CONFIG_HOME": "/tmp/helm/config",
	"HELM_DATA_HOME":   "/tmp/helm/data",
}

func (helmCheck) Run(ctx context.Context, in *Input) *Result {
	res := &Result{ToolRefs: helmToolRefs()}
	if in.ToolsetVolume == "" {
		unavailable := in.toolsetUnavailable("the Helm binary")
		unavailable.ToolRefs = res.ToolRefs
		return unavailable
	}
	res.Command = []string{toolvolume.HelmBin, "lint", "--strict", "<chart>"}

	charts := helmCharts(in.Project)
	// The rendering is shared with repository.kubernetes: charts render once
	// per Run, whichever Check asks first.
	rendered := renderHelmCharts(ctx, in)
	if rendered.Err != nil {
		return failedToRun(res, rendered.Err)
	}
	if f := rendered.Failed; f != nil {
		res.Tool = toolInfo(toolset.HelmRunner, f.ExitCode)
		res.Status, res.ReasonCode = resultset.StatusToolError, "tool_failed"
		res.Reason = fmt.Sprintf("helm exited with %d: %s", f.ExitCode, tail(f.Stderr, 400))
		return res
	}
	blocked, n, worst := 0, 0, rendered.Worst
	// run starts one Helm container for `helm lint` and returns it, or false once the Check is over.
	run := func(cmd []string) (*docker.ContainerResult, bool) {
		n++
		spec := toolContainer(in, fmt.Sprintf("helm-%d", n), toolset.HelmRunner, cmd, "", helmEnv)
		spec.Mounts = append(spec.Mounts, docker.Mount{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true})
		c, err := in.Docker.RunContainer(ctx, spec)
		if err != nil {
			failedToRun(res, err)
			return nil, false
		}
		worst = max(worst, c.ExitCode)
		res.Tool = toolInfo(toolset.HelmRunner, worst)
		if c.ExitCode > 1 {
			res.Status = resultset.StatusToolError
			res.ReasonCode = "tool_failed"
			res.Reason = fmt.Sprintf("helm exited with %d: %s", c.ExitCode, tail(string(c.Stderr), 400))
			return nil, false
		}
		return c, true
	}

	for _, chart := range charts {
		if len(chart.Missing) > 0 {
			blocked++
			p, id := chart.file("Chart.yaml"), helmID
			res.Limitations = append(res.Limitations, resultset.Limitation{
				ReasonCode: reasonDependenciesNotVendored,
				Message: fmt.Sprintf("the chart declares dependencies that are not vendored under charts/ (%s), and Helm cannot download them without network access, so the chart was not linted or rendered",
					strings.Join(chart.Missing, ", ")),
				CheckID: &id, Path: &p,
			})
			continue
		}

		c, ok := run(helmLintCommand(chart.Dir))
		if !ok {
			return res
		}
		out := string(c.Stdout)
		found := helmLintFindings(in, chart.Dir, out)
		if c.ExitCode != 0 && len(found) == 0 {
			found = append(found, helmLintFailure(in, chart.Dir, string(c.Stderr)+out))
		}
		res.Findings = append(res.Findings, found...)

		for _, values := range append([]string{""}, chart.Values...) {
			if r := rendered.lookup(chart.Dir, values); r != nil && r.ExitCode != 0 {
				res.Findings = append(res.Findings, helmRenderFailure(in, chart.Dir, values, r.Stderr))
			}
		}
	}

	switch {
	case blocked == len(charts):
		res.Status, res.ReasonCode = resultset.StatusBlocked, reasonDependenciesNotVendored
		res.Reason = fmt.Sprintf("every chart (%d) has dependencies that are not vendored under charts/", blocked)
	case blocked > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, reasonDependenciesNotVendored
		res.Reason = fmt.Sprintf("%d of %d charts have dependencies that are not vendored under charts/", blocked, len(charts))
	default:
		res.Status = resultset.StatusCompleted
	}
	return res
}

// helmMessage starts a lint message: "[ERROR] templates/x.yaml: text".
var helmMessage = regexp.MustCompile(`^\[(INFO|WARNING|ERROR)\] ?(.*)$`)

// helmLintFindings reads the plain text of `helm lint`. Every INFO, WARNING and
// ERROR message is a Finding, and none is a Gate: a lint error alone does not
// say that the chart cannot be deployed, the render does.
func helmLintFindings(in *Input, dir, output string) []resultset.Finding {
	type message struct{ level, text string }
	var messages []message
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimRight(line, "\r")
		if m := helmMessage.FindStringSubmatch(line); m != nil {
			messages = append(messages, message{m[1], m[2]})
		} else if len(messages) > 0 && (strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "  ")) {
			messages[len(messages)-1].text += "\n" + strings.TrimSpace(line)
		}
	}
	var out []resultset.Finding
	for _, m := range messages {
		file, text, _ := strings.Cut(m.text, ": ")
		file = strings.TrimSpace(file)
		if strings.Contains(file, " ") || strings.Contains(file, "\n") || !strings.Contains(m.text, ": ") {
			file, text = "", m.text // no file name in front of the text
		}
		level := map[string]string{"INFO": "info", "WARNING": "warning", "ERROR": "error"}[m.level]
		rel := chartFileOrChartYaml(in, dir, file)
		f := repoFinding(in, helmID, toolProblem{
			Tool: "helm", Rule: "helm.lint", Level: level, Path: rel,
			Message: strings.TrimSpace(text), Raw: m.text,
		})
		f.Gate = false
		out = append(out, f)
	}
	return out
}

// helmLintFailure is the Finding for a failed `helm lint` that printed no
// message, such as a chart that cannot be loaded at all.
func helmLintFailure(in *Input, dir, output string) resultset.Finding {
	text := strings.TrimSpace(output)
	f := repoFinding(in, helmID, toolProblem{
		Tool: "helm", Rule: "helm.lint", Level: "error", Path: chartFileOrChartYaml(in, dir, ""),
		Message: "helm lint failed: " + tail(text, 300), Raw: text,
	})
	f.Gate = false
	return f
}

// helmRenderFailure is the Gate for a chart that does not render, with its
// default values or with one values file.
func helmRenderFailure(in *Input, dir, values, stderr string) resultset.Finding {
	text := strings.TrimSpace(stderr)
	what, at, detail := "default values", chartFileOrChartYaml(in, dir, ""), "default"
	if values != "" {
		what, detail = "values file "+values, values
		at = chartFileOrChartYaml(in, dir, values)
	}
	chart := dir
	if chart == "." {
		chart = "the project root"
	}
	rule := "helm.template"
	f := repoFinding(in, helmID, toolProblem{
		Tool: "helm", Rule: rule, Level: "error", Path: at,
		Message: fmt.Sprintf("chart in %s does not render with its %s: %s", chart, what, tail(strings.TrimPrefix(text, "Error: "), 300)),
		Raw:     text,
	})
	// The same chart can fail with several values files; each is its own Finding.
	f.Fingerprint = resultset.NewFingerprint(helmID, rule, path.Join(dir, "Chart.yaml"), detail)
	f.Title = cutTitle(fmt.Sprintf("Chart %s does not render with %s", chart, what))
	return f
}

// chartFileOrChartYaml returns the project-relative path of a file that Helm
// named relative to the chart folder, or the chart's Chart.yaml when the name
// is empty, a folder or not a regular file of the Snapshot.
func chartFileOrChartYaml(in *Input, dir, name string) string {
	fallback := path.Join(dir, "Chart.yaml")
	name = path.Clean(strings.TrimPrefix(name, "/"))
	if name == "." || strings.HasPrefix(name, "..") {
		return fallback
	}
	rel := path.Join(dir, name)
	if info, err := os.Lstat(filepath.Join(in.SnapshotDir, filepath.FromSlash(rel))); err != nil || !info.Mode().IsRegular() {
		return fallback
	}
	return rel
}
