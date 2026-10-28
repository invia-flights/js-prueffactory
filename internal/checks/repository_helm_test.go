package checks

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

const v2Chart = "apiVersion: v2\nname: app\nversion: 0.1.0\n"

func TestRepositoryHelmIsImplementedAndCanFireGates(t *testing.T) {
	entry, ok := Lookup("repository.helm")
	if !ok || entry.Status != Implemented || entry.Scope != PerProject || !entry.CanFireGates {
		t.Fatalf("repository.helm = %+v, want implemented in the project Context with Gates", entry)
	}
}

func TestEveryFolderWithAChartYamlIsAChartOutsideNodeModulesAndTestData(t *testing.T) {
	proj := tree(t, map[string]string{
		"Chart.yaml":                   v2Chart,
		"deploy/web [a]/Chart.yaml":    v2Chart,
		"deploy/web [a]/values.yaml":   "a: 1\n",
		"test/fixtures/old/Chart.yaml": v2Chart,
		"node_modules/dep/Chart.yaml":  v2Chart,
		"docs/chart.yaml":              "wrong case\n",
	})
	var dirs []string
	for _, c := range helmCharts(proj) {
		dirs = append(dirs, c.Dir)
	}
	if want := []string{".", "deploy/web [a]"}; !slices.Equal(dirs, want) {
		t.Errorf("chart folders = %q, want %q", dirs, want)
	}
}

func TestHelmDoesNotApplyWithoutAChart(t *testing.T) {
	proj := tree(t, map[string]string{"package.json": `{"name":"x"}`, "README.md": "x"})
	got, reason := Implementation("repository.helm").Applicability(proj, &proj.Contexts[0])
	if got != resultset.NotApplicable || reason == "" {
		t.Fatalf("applicability = %v (%q)", got, reason)
	}
	proj = tree(t, map[string]string{"charts/app/Chart.yaml": v2Chart})
	if got, _ := Implementation("repository.helm").Applicability(proj, &proj.Contexts[0]); got != resultset.Applicable {
		t.Fatalf("applicability = %v, want applicable", got)
	}
}

func TestEachValuesFileOfTheChartFolderIsRenderedExceptTheDefaultOne(t *testing.T) {
	proj := tree(t, map[string]string{
		"c/Chart.yaml":                v2Chart,
		"c/values.yaml":               "a: 1\n",
		"c/values-prod.yaml":          "a: 2\n",
		"c/values.staging.yaml":       "a: 3\n",
		"c/values-extra.yml":          "a: 4\n", // wrong extension
		"c/other-values.yaml":         "a: 5\n",
		"c/templates/values-x.yaml":   "a: 6\n", // not in the chart folder itself
		"c/ci/values-ci.yaml":         "a: 7\n",
		"c/values-weird [x]{1}*.yaml": "a: 8\n",
	})
	charts := helmCharts(proj)
	if len(charts) != 1 {
		t.Fatalf("charts = %+v", charts)
	}
	want := []string{"values-prod.yaml", "values-weird [x]{1}*.yaml", "values.staging.yaml"}
	if !slices.Equal(charts[0].Values, want) {
		t.Errorf("values files = %q, want %q", charts[0].Values, want)
	}
}

func TestDependenciesThatAreNotVendoredUnderChartsBlockTheChart(t *testing.T) {
	proj := tree(t, map[string]string{
		// v2: dependencies in Chart.yaml; one vendored as an archive, one as a folder, two missing.
		"a/Chart.yaml": v2Chart + "dependencies:\n- name: nodejs\n  version: 1.2.3\n  repository: https://charts.example.com\n" +
			"- name: sub\n  version: 0.1.0\n  repository: file://../sub\n" +
			"- name: redis\n  version: 18.0.0\n  repository: https://charts.example.com\n" +
			"- name: node\n  version: 1.0.0\n  repository: https://charts.example.com\n",
		"a/charts/nodejs-1.2.3.tgz":  "x",
		"a/charts/sub/Chart.yaml":    v2Chart,
		"a/charts/node-js-1.0.0.tgz": "x", // another chart whose name only starts like "node"
		// v1: dependencies in requirements.yaml.
		"b/Chart.yaml":              "apiVersion: v1\nname: old\nversion: 0.1.0\n",
		"b/requirements.yaml":       "dependencies:\n- name: nodejs\n  version: 1.2.3\n  repository: https://charts.example.com\n",
		"b/charts/nodejs-1.2.3.tgz": "x",
		// v1 without vendored archive.
		"c/Chart.yaml":        "apiVersion: v1\nname: older\nversion: 0.1.0\n",
		"c/requirements.yaml": "dependencies:\n- name: nodejs\n  version: 1.2.3\n",
		// No dependencies at all.
		"d/Chart.yaml": v2Chart,
	})
	missing := map[string][]string{}
	for _, c := range helmCharts(proj) {
		missing[c.Dir] = c.Missing
	}
	want := map[string][]string{"a": {"redis", "node"}, "b": nil, "c": {"nodejs"}, "d": nil}
	for dir, w := range want {
		if !slices.Equal(missing[dir], w) {
			t.Errorf("chart %s: missing = %q, want %q", dir, missing[dir], w)
		}
	}
}

func TestAnUnreadableChartYamlIsStillAChartAndLeftToHelm(t *testing.T) {
	proj := tree(t, map[string]string{"a/Chart.yaml": ":\n  - [broken", "b/Chart.yaml": strings.Repeat("# x\n", 400_000)})
	charts := helmCharts(proj)
	if len(charts) != 2 || len(charts[0].Missing) != 0 || len(charts[1].Missing) != 0 {
		t.Errorf("charts = %+v", charts)
	}
}

// What `helm lint --strict` prints (Helm 3.22): a header, one line per message
// with an INFO, WARNING or ERROR level, continuation lines that start with a
// tab, and a summary.
const helmLintOutput = "==> Linting /snapshot/deploy/web\n" +
	"[INFO] Chart.yaml: icon is recommended\n" +
	"[WARNING] templates/deployment.yaml: object name does not conform to Kubernetes naming requirements: \"web_app\"\n" +
	"[ERROR] templates/: template: web/templates/svc.yaml:4:11: executing \"web/templates/svc.yaml\" at <.Values.service.port>: nil pointer evaluating interface {}.port\n" +
	"\tsecond line of the same message\n" +
	"[ERROR] : unable to load chart\n" +
	"\n" +
	"Error: 1 chart(s) linted, 1 chart(s) failed\n"

func TestHelmLintOutputBecomesFindingsErrorsAreNotGates(t *testing.T) {
	in := repoInput(t, map[string]string{
		"deploy/web/Chart.yaml":                v2Chart,
		"deploy/web/templates/deployment.yaml": "a: b\n",
	})
	got := helmLintFindings(in, "deploy/web", helmLintOutput)
	if len(got) != 4 {
		t.Fatalf("got %d findings, want 4: %+v", len(got), got)
	}
	byLevel := map[string][]resultset.Finding{}
	for _, f := range got {
		if f.CheckID != "repository.helm" || f.ContextID != "C-0001" || f.RuleID == nil || *f.RuleID != "helm.lint" {
			t.Errorf("finding = %+v", f)
		}
		byLevel[string(f.Severity)] = append(byLevel[string(f.Severity)], f)
	}
	for _, f := range got {
		if f.Gate {
			t.Errorf("a lint result is never a Gate: %+v", f)
		}
	}
	if len(byLevel["error"]) != 2 || len(byLevel["warning"]) != 1 || len(byLevel["note"]) != 1 {
		t.Fatalf("levels = %d errors, %d warnings, %d notes", len(byLevel["error"]), len(byLevel["warning"]), len(byLevel["note"]))
	}
	w := byLevel["warning"][0]
	if w.Locations[0].Path != "deploy/web/templates/deployment.yaml" || w.Locations[0].FileSHA256 == "" {
		t.Errorf("warning location = %+v", w.Locations[0])
	}
	if w.Kind != resultset.KindDefect {
		t.Errorf("warning kind = %v", w.Kind)
	}
	if byLevel["note"][0].Kind != resultset.KindHint {
		t.Errorf("an INFO message is a hint: %+v", byLevel["note"][0])
	}
	// A folder or no file at all points at the chart's Chart.yaml.
	for _, e := range byLevel["error"] {
		if e.Locations[0].Path != "deploy/web/Chart.yaml" {
			t.Errorf("error location = %+v, want the Chart.yaml", e.Locations[0])
		}
		if e.Confidence != resultset.ConfidenceConfirmed {
			t.Errorf("error confidence = %v", e.Confidence)
		}
	}
	if !strings.Contains(byLevel["error"][0].Evidence[0].Text, "second line") {
		t.Errorf("continuation lines belong to the message: %q", byLevel["error"][0].Evidence[0].Text)
	}
	if byLevel["error"][0].Evidence[0].Trust != resultset.TrustUntrusted {
		t.Error("tool output is untrusted evidence")
	}
}

func TestAFailedHelmLintWithoutAnyMessageIsStillAnError(t *testing.T) {
	in := repoInput(t, map[string]string{"Chart.yaml": v2Chart})
	got := helmLintFailure(in, ".", "Error: something unexpected\n")
	if got.Severity != resultset.SeverityError || got.Gate || got.Locations[0].Path != "Chart.yaml" {
		t.Errorf("finding = %+v", got)
	}
}

func TestAChartThatFailsToRenderIsAGate(t *testing.T) {
	in := repoInput(t, map[string]string{"web/Chart.yaml": v2Chart, "web/values-prod.yaml": "a: 1\n"})
	def := helmRenderFailure(in, "web", "", "Error: template: web/templates/x.yaml:1:3: executing nil pointer\n")
	prod := helmRenderFailure(in, "web", "values-prod.yaml", "Error: boom\n")

	for _, f := range []resultset.Finding{def, prod} {
		if !f.Gate || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed || f.Kind != resultset.KindDefect {
			t.Errorf("render failure = %+v", f)
		}
		if *f.RuleID != "helm.template" {
			t.Errorf("rule = %q", *f.RuleID)
		}
	}
	if def.Locations[0].Path != "web/Chart.yaml" || !strings.Contains(def.Message, "default values") {
		t.Errorf("default render failure = %+v", def)
	}
	if prod.Locations[0].Path != "web/values-prod.yaml" || !strings.Contains(prod.Message, "values-prod.yaml") {
		t.Errorf("values render failure = %+v", prod)
	}
	if def.Fingerprint == prod.Fingerprint {
		t.Error("the two failures must differ in identity")
	}
}

func TestHelmContainersGetOnlyAbsolutePathsSoNothingReadsAsAnOption(t *testing.T) {
	cmd := helmLintCommand(".")
	if !slices.Equal(cmd, []string{"/toolset/bin/helm", "lint", "--strict", "/snapshot"}) {
		t.Errorf("lint command = %q", cmd)
	}
	cmd = helmTemplateCommand("-rf", "--set=x.yaml")
	want := []string{"/toolset/bin/helm", "template", "jspf", "/snapshot/-rf", "-f", "/snapshot/-rf/--set=x.yaml"}
	if !slices.Equal(cmd, want) {
		t.Errorf("template command = %q, want %q", cmd, want)
	}
	cmd = helmTemplateCommand("-rf", "")
	if !slices.Equal(cmd, want[:4]) {
		t.Errorf("template command without values = %q", cmd)
	}
}

func TestHelmRunsInThePinnedAlpineImageAndIsRecordedWithItsDigest(t *testing.T) {
	proj := tree(t, map[string]string{"Chart.yaml": v2Chart})
	images := Implementation("repository.helm").(ImageUser).Images(&proj.Contexts[0])
	if !slices.Equal(images, []string{toolset.Alpine.Ref()}) {
		t.Errorf("images = %q", images)
	}
	if !Implementation("repository.helm").(ToolsetUser).UsesToolset(&proj.Contexts[0]) {
		t.Error("the Helm binary comes from the toolset volume")
	}
	refs := helmToolRefs()
	names := map[string]resultset.ToolRef{}
	for _, r := range refs {
		names[r.Name] = r
	}
	if names["helm"].Version != toolset.Helm.Version || names["alpine"].Digest == nil || *names["alpine"].Digest != toolset.Alpine.Digest {
		t.Errorf("tool refs = %+v", refs)
	}
}
