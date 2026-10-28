//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func limitationsOf(s *resultset.Set, check string) []resultset.Limitation {
	var out []resultset.Limitation
	for _, l := range s.Limitations {
		if l.CheckID != nil && *l.CheckID == check {
			out = append(out, l)
		}
	}
	return out
}

func TestInvalidKubernetesResourcesFailTheRunAndCustomResourcesAreALimitation(t *testing.T) {
	original := copyProject(t, "ci-files")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "repository.kubernetes")

	if r.code != 1 {
		reason := ""
		if p := executionOf(t, &r.set, "repository.kubernetes").Reason; p != nil {
			reason = *p
		}
		t.Fatalf("exit = %d, want 1\nreason: %s\nstderr:\n%s", r.code, reason, r.stderr)
	}
	e := executionOf(t, &r.set, "repository.kubernetes")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" || e.Gate != 2 {
		t.Fatalf("execution = status %s outcome %s context %s gates %d (reason %v), want completed, failed, C-0001, 2", e.Status, e.Outcome, e.ContextID, e.Gate, e.Reason)
	}
	if e.Tool == nil || e.Tool.Name != "kubeconform" || e.Tool.Version == nil || *e.Tool.Version != "0.8.0" {
		t.Errorf("tool = %+v, want kubeconform 0.8.0", e.Tool)
	}

	gates := gatesByPath(&r.set, "repository.kubernetes")
	if len(gates) != 2 {
		t.Fatalf("gates = %+v, want one in the plain manifest and one for the chart", gates)
	}
	plain, ok := gates["k8s/deployment.yaml"]
	if !ok || !strings.Contains(plain.Title, "Deployment/api") || *plain.RuleID != "kubernetes.invalid" {
		t.Errorf("plain manifest gate = %+v", plain)
	}
	if !ok || len(plain.Evidence) == 0 || plain.Evidence[0].Trust != resultset.TrustUntrusted || !strings.Contains(plain.Evidence[0].Text, "replicas") {
		t.Errorf("plain manifest evidence = %+v, want the validation error about replicas as untrusted text", plain.Evidence)
	}

	// The chart renders the same invalid Deployment with both values files:
	// one Finding that names the chart, the template and both values files.
	chart, ok := gates["charts/web/templates/deployment.yaml"]
	if !ok || !strings.Contains(chart.Title, "Deployment/jspf-web") {
		t.Fatalf("chart gate = %+v", chart)
	}
	for _, want := range []string{"charts/web", "templates/deployment.yaml", "default values", "values-prod.yaml"} {
		if !strings.Contains(chart.Message, want) {
			t.Errorf("chart gate message %q lacks %q", chart.Message, want)
		}
	}

	// The custom resource is not validated, and says so once.
	limitations := limitationsOf(&r.set, "repository.kubernetes")
	if len(limitations) != 1 || limitations[0].ReasonCode != "kinds_not_validated" || !strings.Contains(limitations[0].Message, "cert-manager.io/v1 Certificate: 1") {
		t.Errorf("limitations = %+v, want one kinds_not_validated naming the Certificate", limitations)
	}
	if r.set.Summary.Gates != 2 {
		t.Errorf("gates = %d, want 2", r.set.Summary.Gates)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestHelmAndKubernetesTogetherRenderTheChartsForBothAndKeepTheirOwnResults(t *testing.T) {
	original := copyProject(t, "ci-files")

	r := realRun(t, context.Background(), "test", original, "--only", "repository.helm,repository.kubernetes")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	// repository.helm has no Gate: the chart renders. Its results are the same
	// as when it runs alone.
	helm := executionOf(t, &r.set, "repository.helm")
	if helm.Status != resultset.StatusCompleted || helm.Gate != 0 {
		t.Errorf("repository.helm = status %s gates %d, want completed with no Gate", helm.Status, helm.Gate)
	}
	kube := executionOf(t, &r.set, "repository.kubernetes")
	if kube.Status != resultset.StatusCompleted || kube.Gate != 2 {
		t.Errorf("repository.kubernetes = status %s gates %d, want completed with 2 Gates", kube.Status, kube.Gate)
	}
}

func TestAChartThatHelmCannotRenderIsLeftOutWithALimitationAndNoGate(t *testing.T) {
	original := copyProject(t, "repository-files")

	r := realRun(t, context.Background(), "test", original, "--only", "repository.helm,repository.kubernetes")

	// repository.helm reports the chart that does not render with values-broken.yaml.
	if helm := executionOf(t, &r.set, "repository.helm"); helm.Gate == 0 {
		t.Errorf("repository.helm gates = %d, want the render failure", helm.Gate)
	}
	kube := executionOf(t, &r.set, "repository.kubernetes")
	if kube.Status != resultset.StatusCompleted || kube.Gate != 0 {
		t.Errorf("repository.kubernetes = status %s gates %d, want completed with no Gate", kube.Status, kube.Gate)
	}
	limitations := limitationsOf(&r.set, "repository.kubernetes")
	var found bool
	for _, l := range limitations {
		found = found || (l.ReasonCode == "chart_not_rendered" && strings.Contains(l.Message, "values-broken.yaml") && strings.Contains(l.Message, "repository.helm"))
	}
	if !found {
		t.Errorf("limitations = %+v, want chart_not_rendered for values-broken.yaml", limitations)
	}
	// The chart still renders with its default values, and that is valid.
	if findings := findingsOf(&r.set, "repository.kubernetes"); len(findings) != 0 {
		t.Errorf("findings = %+v", findings)
	}
}

func TestTheBenchmarkHasAKubernetesPartAndTheKubernetesVersionInTheFingerprint(t *testing.T) {
	original := copyProject(t, "ci-files")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "repository.kubernetes")

	var part *resultset.BenchmarkPart
	for i := range r.set.Benchmark.Areas {
		for j := range r.set.Benchmark.Areas[i].Parts {
			if p := &r.set.Benchmark.Areas[i].Parts[j]; p.ID == "kubernetes" {
				part = p
			}
		}
	}
	if part == nil || part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue != 2 {
		t.Fatalf("Kubernetes part = %+v, want measured with two invalid resources", part)
	}
	v := r.set.Benchmark.Fingerprint.Fields.KubernetesSchemaVersion
	if v == nil || *v != "1.34.1" {
		t.Errorf("Kubernetes schema version = %v, want 1.34.1", v)
	}
}
