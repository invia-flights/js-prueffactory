package toolset

import (
	"regexp"
	"strings"
	"testing"
)

func TestKubeconformIsPinnedByTheDigestOfItsMultiArchIndex(t *testing.T) {
	if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(Kubeconform.Image.Digest) {
		t.Errorf("digest = %q", Kubeconform.Image.Digest)
	}
	if !strings.HasSuffix(Kubeconform.Image.Tag, Kubeconform.Version) {
		t.Errorf("tag %q does not match version %q", Kubeconform.Image.Tag, Kubeconform.Version)
	}
}

func TestTheSchemaTableHasTheFixedKindsOfOneKubernetesVersionWithChecksums(t *testing.T) {
	sum := regexp.MustCompile(`^[0-9a-f]{64}$`)
	names := map[string]bool{}
	for _, f := range KubernetesSchemas {
		names[f.Name()] = true
		if !sum.MatchString(f.SHA256) {
			t.Errorf("%s: checksum %q is not a SHA-256", f.Name(), f.SHA256)
		}
		if !strings.Contains(f.Raw, "/"+KubernetesSchemaFolder+"/") {
			t.Errorf("%s: %s is not in the %s folder", f.Name(), f.Raw, KubernetesSchemaFolder)
		}
		if !strings.HasPrefix(f.Raw, "https://") {
			t.Errorf("%s: %s is not an https address", f.Name(), f.Raw)
		}
	}
	kinds := []string{
		"deployment-apps-v1", "statefulset-apps-v1", "daemonset-apps-v1", "replicaset-apps-v1", "pod-v1",
		"job-batch-v1", "cronjob-batch-v1", "service-v1", "ingress-networking-v1", "configmap-v1", "secret-v1",
		"serviceaccount-v1", "role-rbac-v1", "rolebinding-rbac-v1", "clusterrole-rbac-v1", "clusterrolebinding-rbac-v1",
		"horizontalpodautoscaler-autoscaling-v2", "poddisruptionbudget-policy-v1", "networkpolicy-networking-v1",
		"persistentvolumeclaim-v1", "namespace-v1",
	}
	for _, k := range kinds {
		if !names[k+".json"] {
			t.Errorf("no schema for %s", k)
		}
	}
	if len(names) != len(KubernetesSchemas) {
		t.Errorf("%d files, %d distinct names", len(KubernetesSchemas), len(names))
	}
}

func TestEverySchemaChecksumIsPartOfTheToolsetVersion(t *testing.T) {
	got := entries["kubernetes-schemas"]
	for _, f := range KubernetesSchemas {
		if !strings.Contains(got, f.SHA256) {
			t.Errorf("the toolset table does not hold the checksum of %s", f.Name())
		}
	}
}
