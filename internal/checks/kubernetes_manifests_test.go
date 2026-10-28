package checks

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const podManifest = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n"

func TestPlainManifestsAreYamlFilesWithTopLevelStringApiVersionAndKind(t *testing.T) {
	proj := tree(t, map[string]string{
		"k8s/deploy.yaml":       podManifest,
		"k8s/more.yml":          "# two documents\n---\nreplicas: 1\n---\n" + podManifest,
		"k8s/ordered.yaml":      "kind: Pod\napiVersion: v1\n",
		"k8s/no-kind.yaml":      "apiVersion: v1\nmetadata: {name: x}\n",
		"k8s/no-version.yaml":   "kind: Pod\n",
		"k8s/number-kind.yaml":  "apiVersion: v1\nkind: 5\n",
		"k8s/nested.yaml":       "spec:\n  apiVersion: v1\n  kind: Pod\n",
		"k8s/list.yaml":         "- apiVersion: v1\n  kind: Pod\n",
		"k8s/values.yaml":       "replicas: 2\nimage: nginx\n",
		"k8s/broken.yaml":       "apiVersion: v1\nkind: Pod\n  bad: [\n",
		"k8s/readme.md":         podManifest,
		"k8s/manifest.yaml.txt": podManifest,
		"weird [x]/a b.yaml":    podManifest,
		"templates/x.yaml":      podManifest, // not in a Helm chart
	})
	got, tooLarge := kubernetesManifests(proj)
	want := []string{"k8s/deploy.yaml", "k8s/more.yml", "k8s/ordered.yaml", "templates/x.yaml", "weird [x]/a b.yaml"}
	if !slices.Equal(got, want) {
		t.Errorf("manifests = %q, want %q", got, want)
	}
	if len(tooLarge) != 0 {
		t.Errorf("too large = %q", tooLarge)
	}
}

func TestManifestsInHelmTemplatesTestDataBuildOutputAndNodeModulesAreLeftOut(t *testing.T) {
	proj := tree(t, map[string]string{
		"chart/Chart.yaml":                  v2Chart,
		"chart/templates/deployment.yaml":   "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n",
		"chart/templates/sub/pod.yaml":      podManifest,
		"chart/charts/dep/Chart.yaml":       v2Chart,
		"chart/charts/dep/templates/a.yaml": podManifest,
		"chart/crds/crd.yaml":               "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
		"test/fixtures/bad.yaml":            podManifest,
		"dist/out.yaml":                     podManifest,
		"node_modules/dep/k8s.yaml":         podManifest,
		"deploy/pod.yaml":                   podManifest,
	})
	got, _ := kubernetesManifests(proj)
	want := []string{"chart/crds/crd.yaml", "deploy/pod.yaml"}
	if !slices.Equal(got, want) {
		t.Errorf("manifests = %q, want %q", got, want)
	}
}

func TestAHugeManifestIsNamedAndNotRead(t *testing.T) {
	proj := tree(t, map[string]string{
		"big.yaml": podManifest + "# " + strings.Repeat("x", maxProjectFileBytes) + "\n",
		"ok.yaml":  podManifest,
	})
	got, tooLarge := kubernetesManifests(proj)
	if !slices.Equal(got, []string{"ok.yaml"}) || !slices.Equal(tooLarge, []string{"big.yaml"}) {
		t.Errorf("manifests = %q, too large = %q", got, tooLarge)
	}
}

func TestKubernetesAppliesToAChartOrAPlainManifestAndNothingElse(t *testing.T) {
	for name, tc := range map[string]struct {
		files map[string]string
		want  bool
	}{
		"nothing":            {map[string]string{"package.json": "{}"}, false},
		"a chart":            {map[string]string{"c/Chart.yaml": v2Chart}, true},
		"manifest":           {map[string]string{"k/pod.yaml": podManifest}, true},
		"only a values file": {map[string]string{"k/values.yaml": "a: 1\n"}, false},
	} {
		proj := tree(t, tc.files)
		got, reason := Implementation("repository.kubernetes").Applicability(proj, &proj.Contexts[0])
		if (got == resultset.Applicable) != tc.want || (!tc.want && reason == "") {
			t.Errorf("%s: applicability = %v (%q)", name, got, reason)
		}
	}
}
