//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests are seam A for api.lint on an OpenAPI file that is not valid YAML:
// whole Runs on the made-up project `unparseable-openapi`, whose only defect is
// a control character (U+0001) YAML 1.2 forbids in openapi.yaml.

func TestAnUnparseableOpenAPIFileIsOneGateOfArtifactsStructuredAndApiLintLeavesItAlone(t *testing.T) {
	original := copyProject(t, "unparseable-openapi")

	r := realRun(t, context.Background(), "benchmark", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	structured := gatesByPath(&r.set, "artifacts.structured")
	if f, ok := structured["openapi.yaml"]; !ok || *f.RuleID != "invalid-yaml" || len(structured) != 1 {
		t.Errorf("artifacts.structured gates = %+v", structured)
	}
	if gates := gatesByPath(&r.set, "api.lint"); len(gates) != 0 {
		t.Errorf("api.lint adds no second Gate: %+v", gates)
	}
	e := executionOf(t, &r.set, "api.lint")
	if e.Status != resultset.StatusCompleted || e.ReasonCode != nil {
		t.Errorf("api.lint = status %s reason %v, want completed", e.Status, e.ReasonCode)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "file_not_parseable" && l.CheckID != nil && *l.CheckID == "api.lint" &&
			l.Path != nil && *l.Path == "openapi.yaml" && strings.Contains(l.Message, "artifacts.structured") {
			limited = true
		}
	}
	if !limited {
		t.Errorf("no file_not_parseable Limitation: %+v", r.set.Limitations)
	}

	// The file counts once, in the Structured files part, and OpenAPI is not unknown.
	if p := benchmarkPart(t, &r.set, "structured_files"); p.State != resultset.PartMeasured || p.RawValue == nil || *p.RawValue != 1 {
		t.Errorf("structured files = %+v, want one hit", p)
	}
	if p := benchmarkPart(t, &r.set, "openapi"); p.State != resultset.PartMeasured || p.RawValue == nil || *p.RawValue != 0 {
		t.Errorf("openapi = %+v, want measured with no hits", p)
	}
	r.assertNothingLeft(t)
}

func TestAnUnparseableOpenAPIFileIsAGateOfApiLintWhenArtifactsStructuredIsNotSelected(t *testing.T) {
	original := copyProject(t, "unparseable-openapi")

	r := realRun(t, context.Background(), "test", original, "--only", "api.lint")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := executionOf(t, &r.set, "api.lint")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.Gate != 1 {
		t.Fatalf("api.lint = status %s outcome %s gates %d reason %v %v", e.Status, e.Outcome, e.Gate, e.ReasonCode, e.Reason)
	}
	f, ok := gatesByPath(&r.set, "api.lint")["openapi.yaml"]
	if !ok || *f.RuleID != "unparseable" || len(f.Evidence) != 1 || strings.TrimSpace(f.Evidence[0].Text) == "" {
		t.Fatalf("gate = %+v", f)
	}
	t.Logf("evidence: %q", f.Evidence[0].Text)
	r.assertNothingLeft(t)
}
