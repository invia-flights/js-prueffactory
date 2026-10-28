//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestAnInvalidComposeSetFailsTheRunAndAMissingVariableIsOnlyAWarning(t *testing.T) {
	original := copyProject(t, "ci-files")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "repository.compose")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := executionOf(t, &r.set, "repository.compose")
	// The set with a remote include is not run, so the Check is partial.
	if e.Status != resultset.StatusPartial || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" || e.Gate != 1 {
		t.Fatalf("execution = status %s outcome %s context %s gates %d (reason %v), want partial, failed, C-0001, 1", e.Status, e.Outcome, e.ContextID, e.Gate, e.Reason)
	}
	if e.Tool == nil || e.Tool.Name != "docker-cli" {
		t.Errorf("tool = %+v, want docker-cli", e.Tool)
	}

	invalid := ruleFindings(&r.set, "repository.compose", "compose.invalid")
	if len(invalid) != 1 || !invalid[0].Gate || invalid[0].Locations[0].Path != "compose.broken.yaml" {
		t.Fatalf("invalid findings = %+v, want one Gate in compose.broken.yaml", invalid)
	}
	ev := invalid[0].Evidence
	if len(ev) != 1 || ev[0].Trust != resultset.TrustUntrusted || !strings.Contains(ev[0].Text, "prots") {
		t.Errorf("evidence = %+v, want compose's message about prots as untrusted text", ev)
	}

	// The override file of the default set reads a variable that nothing answers.
	missing := ruleFindings(&r.set, "repository.compose", "compose.variable-missing")
	if len(missing) != 1 || missing[0].Gate || missing[0].Severity != resultset.SeverityWarning ||
		!strings.Contains(missing[0].Title, "CI_API_URL") || missing[0].Locations[0].Path != "compose.yaml" {
		t.Errorf("variable findings = %+v, want one warning for CI_API_URL in the default set", missing)
	}

	limitations := limitationsOf(&r.set, "repository.compose")
	if len(limitations) != 1 || limitations[0].ReasonCode != "include_not_resolved" ||
		!strings.Contains(limitations[0].Message, "https://git.example.com/platform/shared-compose.git") {
		t.Errorf("limitations = %+v, want one include_not_resolved for the remote include", limitations)
	}
	if r.set.Summary.Gates != 1 {
		t.Errorf("gates = %d, want 1", r.set.Summary.Gates)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestTheProjectsEnvFileAnswersComposeVariables(t *testing.T) {
	original := copyProject(t, "ci-files")
	for _, f := range []string{"compose.broken.yaml", "compose.remote.yaml"} {
		if err := os.Remove(filepath.Join(original, f)); err != nil {
			t.Fatal(err)
		}
	}

	r := realRun(t, context.Background(), "test", original, "--only", "repository.compose")
	if got := ruleFindings(&r.set, "repository.compose", "compose.variable-missing"); len(got) != 1 {
		t.Fatalf("variable findings = %+v, want the warning while nothing answers the variable", got)
	}

	if err := os.WriteFile(filepath.Join(original, ".env"), []byte("CI_API_URL=https://api.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = realRun(t, context.Background(), "test", original, "--only", "repository.compose")
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if got := findingsOf(&r.set, "repository.compose"); len(got) != 0 {
		t.Errorf("findings = %+v, want none once .env answers the variable", got)
	}
	if e := executionOf(t, &r.set, "repository.compose"); e.Status != resultset.StatusCompleted {
		t.Errorf("status = %s, want completed", e.Status)
	}
}

func TestARequiredComposeVariableIsAWarningToo(t *testing.T) {
	original := copyProject(t, "ci-files")
	for _, f := range []string{"compose.broken.yaml", "compose.remote.yaml", "compose.override.yaml"} {
		if err := os.Remove(filepath.Join(original, f)); err != nil {
			t.Fatal(err)
		}
	}
	required := "services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - \"${WEB_PORT:?set WEB_PORT}:80\"\n"
	if err := os.WriteFile(filepath.Join(original, "compose.yaml"), []byte(required), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "repository.compose")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	missing := ruleFindings(&r.set, "repository.compose", "compose.variable-missing")
	if len(missing) != 1 || missing[0].Gate || !strings.Contains(missing[0].Title, "WEB_PORT") {
		t.Errorf("variable findings = %+v, want one warning for WEB_PORT", missing)
	}
	if invalid := ruleFindings(&r.set, "repository.compose", "compose.invalid"); len(invalid) != 0 {
		t.Errorf("invalid findings = %+v, want none", invalid)
	}
}

func TestTheBenchmarkHasAComposePartThatCountsInvalidSets(t *testing.T) {
	original := copyProject(t, "ci-files")
	// A set with a remote include makes the Check partial, and a partial Check
	// leaves its part unknown.
	if err := os.Remove(filepath.Join(original, "compose.remote.yaml")); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "benchmark", original, "--only", "repository.compose")

	var part *resultset.BenchmarkPart
	for i := range r.set.Benchmark.Areas {
		for j := range r.set.Benchmark.Areas[i].Parts {
			if p := &r.set.Benchmark.Areas[i].Parts[j]; p.ID == "compose" {
				part = p
			}
		}
	}
	if part == nil || part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue != 1 {
		t.Fatalf("Compose part = %+v, want measured with one invalid set", part)
	}
}
