package checks

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// This file turns what kubeconform printed into Findings and one Limitation,
// and splits what `helm template` printed into one manifest per template.

const (
	ruleKubernetesInvalid = "kubernetes.invalid"
	ruleKubernetesError   = "kubernetes.error"

	reasonKindsNotValidated = "kinds_not_validated"

	// maxKindsListed bounds the kinds a Limitation names.
	maxKindsListed = 20
)

// kubeSource is where a file that kubeconform validated came from.
type kubeSource struct {
	// Path is the project-relative file a Finding points at: the manifest
	// itself, or the chart's template.
	Path string
	// Chart is the chart folder, empty for a plain manifest. Template is the
	// template inside it, and Values the values file the chart was rendered
	// with, empty for the default values.
	Chart, Template, Values string
}

// kubeInvalid is one invalid resource, merged over the values files that
// render it.
type kubeInvalid struct {
	source     kubeSource
	apiVersion string
	kind, name string
	status     string
	values     []string // values files it is invalid with, "" for the defaults
	messages   []kubeMessage
}

// kubeMessage is what kubeconform said about a resource, and the values files
// it said it with.
type kubeMessage struct {
	text   string
	values []string
}

// kubeAnalysis collects what kubeconform said about every file it was given.
type kubeAnalysis struct {
	invalid map[string]*kubeInvalid
	order   []string
	// skipped holds the distinct resources without a schema, by "apiVersion kind".
	skipped map[string]map[string]bool
}

func newKubeAnalysis() *kubeAnalysis {
	return &kubeAnalysis{invalid: map[string]*kubeInvalid{}, skipped: map[string]map[string]bool{}}
}

// kubeRecord is one entry of kubeconform's `-output json` document.
type kubeRecord struct {
	Filename         string `json:"filename"`
	Kind             string `json:"kind"`
	Name             string `json:"name"`
	Version          string `json:"version"`
	Status           string `json:"status"`
	Msg              string `json:"msg"`
	ValidationErrors []struct {
		Path string `json:"path"`
		Msg  string `json:"msg"`
	} `json:"validationErrors"`
}

// add reads the output of one kubeconform run. sources maps the file names the
// run was given to where they came from.
func (a *kubeAnalysis) add(sources map[string]kubeSource, stdout []byte) error {
	var doc struct {
		Resources []kubeRecord `json:"resources"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return fmt.Errorf("kubeconform printed no JSON, it said: %s", outputHead(stdout))
	}
	for _, r := range doc.Resources {
		src, ok := sources[r.Filename]
		if !ok {
			return fmt.Errorf("kubeconform reported on a file it was not given")
		}
		switch r.Status {
		case "statusInvalid", "statusError":
			a.addInvalid(src, r)
		case "statusSkipped":
			key := r.Version + " " + r.Kind
			if a.skipped[key] == nil {
				a.skipped[key] = map[string]bool{}
			}
			a.skipped[key][src.Path+"\x00"+r.Name] = true
		}
	}
	return nil
}

func (a *kubeAnalysis) addInvalid(src kubeSource, r kubeRecord) {
	key := strings.Join([]string{src.Path, src.Chart, r.Version, r.Kind, r.Name, r.Status}, "\x00")
	inv := a.invalid[key]
	if inv == nil {
		inv = &kubeInvalid{source: src, apiVersion: r.Version, kind: r.Kind, name: r.Name, status: r.Status}
		a.invalid[key] = inv
		a.order = append(a.order, key)
	}
	inv.values = append(inv.values, src.Values)
	text := r.Msg
	if len(r.ValidationErrors) > 0 {
		text = ""
		for _, e := range r.ValidationErrors {
			text += e.Path + ": " + e.Msg + "\n"
		}
	}
	text = strings.TrimSpace(text)
	for i := range inv.messages {
		if inv.messages[i].text == text {
			inv.messages[i].values = append(inv.messages[i].values, src.Values)
			return
		}
	}
	inv.messages = append(inv.messages, kubeMessage{text: text, values: []string{src.Values}})
}

// findings returns the Findings in the order the invalid resources were seen.
func (a *kubeAnalysis) findings(in *Input) []resultset.Finding {
	var out []resultset.Finding
	for _, key := range a.order {
		inv := a.invalid[key]
		out = append(out, invalidResourceFinding(in, inv))
	}
	return out
}

func invalidResourceFinding(in *Input, inv *kubeInvalid) resultset.Finding {
	rule, gate := ruleKubernetesInvalid, inv.status == "statusInvalid"
	if !gate {
		rule = ruleKubernetesError
	}
	resource := shownWord(inv.kind, "kind") + "/" + shownWord(inv.name, "name")
	where := "the file " + shownPath(inv.source.Path)
	if inv.source.Chart != "" {
		chart := "the project root"
		if inv.source.Chart != "." {
			chart = shownPath(inv.source.Chart)
		}
		where = fmt.Sprintf("template %s of the chart in %s, rendered with %s", shownPath(inv.source.Template), chart, valuesList(inv.values, true))
	}
	f := resultset.Finding{
		CheckID: kubernetesID, ContextID: in.Context.ID,
		RuleID:      &rule,
		Fingerprint: resultset.NewFingerprint(kubernetesID, rule, inv.source.Path, inv.source.Chart+" "+inv.kind+"/"+inv.name),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError,
		Confidence: resultset.ConfidenceConfirmed, Gate: gate,
		Locations:    []resultset.Location{in.Location("primary", inv.source.Path, 0, 0)},
		Reproduction: in.Reproduction(kubernetesID),
		Limitations:  []string{},
	}
	if gate {
		f.Title = cutTitle("Invalid Kubernetes resource " + resource)
		f.Message = fmt.Sprintf("kubeconform reports the resource %s in %s as invalid against the Kubernetes %s schema, so a cluster would reject it. The validation errors are in the Evidence.", resource, where, toolset.KubernetesVersion)
	} else {
		f.Kind, f.Severity, f.Confidence = resultset.KindHint, resultset.SeverityWarning, resultset.ConfidenceSuspected
		f.Title = cutTitle("Kubernetes resource " + resource + " could not be validated")
		f.Message = fmt.Sprintf("kubeconform could not validate the resource %s in %s. What it said is in the Evidence.", resource, where)
	}
	// The kind and name are the project's own text, so they go here and not
	// into the trusted fields unless they look like names (see shownWord).
	for _, m := range inv.messages {
		text := fmt.Sprintf("%s %s (%s)\n%s", inv.kind, inv.name, inv.apiVersion, m.text)
		if len(inv.messages) > 1 {
			text = valuesList(m.values, false) + ": " + text
		}
		f.Evidence = append(f.Evidence, Untrusted("tool_output", text, "kubeconform"))
	}
	if inv.source.Chart != "" {
		// Where the resource came from, exactly as the project and Helm spell it.
		src := fmt.Sprintf("chart folder %s, template %s, %s", inv.source.Chart, inv.source.Template, valuesList(inv.values, false))
		f.Evidence = append(f.Evidence, Untrusted("tool_output", src, "helm template"))
	}
	return f
}

// valuesList names the values files of a chart render: "default values" and
// "values file X", joined. With shown, a name that does not look like a path is
// replaced by a placeholder, for use in trusted text.
func valuesList(values []string, shown bool) string {
	seen := map[string]bool{}
	var names []string
	for _, v := range values {
		if seen[v] {
			continue
		}
		seen[v] = true
		if v == "" {
			names = append(names, "default values")
		} else {
			if shown {
				v = shownPath(v)
			}
			names = append(names, "values file "+v)
		}
	}
	sort.SliceStable(names, func(i, j int) bool { return names[i] == "default values" && names[j] != "default values" })
	return strings.Join(names, ", ")
}

// limitations returns the Limitation that names the kinds without a schema,
// or nothing when every resource had one.
func (a *kubeAnalysis) limitations() []resultset.Limitation {
	if len(a.skipped) == 0 {
		return nil
	}
	var shown []string
	unusual, total := 0, 0
	for key, resources := range a.skipped {
		total += len(resources)
		version, kind, _ := strings.Cut(key, " ")
		if !looksLikeWord(version) || !looksLikeWord(kind) {
			unusual += len(resources)
			continue
		}
		shown = append(shown, fmt.Sprintf("%s %s: %d", version, kind, len(resources)))
	}
	sort.Strings(shown)
	list := strings.Join(cutList(shown, maxKindsListed), ", ")
	if unusual > 0 {
		if list != "" {
			list += ", "
		}
		list += fmt.Sprintf("%d resource(s) of kinds with unusual names", unusual)
	}
	id := kubernetesID
	return []resultset.Limitation{{
		ReasonCode: reasonKindsNotValidated, CheckID: &id,
		Message: fmt.Sprintf("%d resource(s) were not validated, because the Kubernetes %s schemas the Check carries do not cover their kind (custom resources and kinds outside its list): %s",
			total, toolset.KubernetesVersion, list),
	}}
}

// renderedTemplate is the part of `helm template` output that one template
// produced.
type renderedTemplate struct {
	// Name is the template relative to the chart folder, such as
	// "templates/deployment.yaml", or empty for a manifest Helm gave no source.
	Name    string
	Content string
}

// splitRendered splits the output of `helm template` at its `---` lines and
// groups the manifests by the `# Source: <chart>/<template>` comment Helm puts
// first in each. The chart name is dropped from the source, since the chart
// folder is already known.
func splitRendered(out string) []renderedTemplate {
	var templates []renderedTemplate
	index := map[string]int{}
	for _, block := range strings.Split("\n"+out, "\n---") {
		if strings.TrimSpace(block) == "" {
			continue
		}
		name := ""
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if rest, ok := strings.CutPrefix(line, "# Source:"); ok {
				_, name, _ = strings.Cut(strings.TrimSpace(rest), "/")
			}
			break
		}
		i, ok := index[name]
		if !ok {
			i = len(templates)
			index[name] = i
			templates = append(templates, renderedTemplate{Name: name})
		}
		templates[i].Content += "---" + block + "\n"
	}
	return templates
}
