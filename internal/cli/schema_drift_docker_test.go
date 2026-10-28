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

// Seam A tests of schema.drift with a real Docker daemon: the generator runs in
// a container on the Run's internal network, in a copy of the Working copy.

// driftExecution returns the execution of schema.drift in the package at path.
func driftExecution(t *testing.T, s *resultset.Set, path string) resultset.Execution {
	t.Helper()
	for _, c := range s.Contexts {
		if c.Kind == "package" && c.Path == path {
			for _, e := range s.Checks {
				if e.CheckID == "schema.drift" && e.ContextID == c.ID {
					return e
				}
			}
		}
	}
	t.Fatalf("no execution of schema.drift in the package %s", path)
	return resultset.Execution{}
}

func TestSchemaDriftReportsAStaleFileAndLeavesFormattingAloneAndAFailingGeneratorIsPartial(t *testing.T) {
	original := copyProject(t, "schema-drift")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "schema.drift")

	// Drift is no Gate, but the failed generator makes the Run incomplete.
	if r.code != 2 || r.set.Summary.Gates != 0 {
		t.Fatalf("exit = %d, gates = %d, want 2 and none\nstderr:\n%s", r.code, r.set.Summary.Gates, r.stderr)
	}
	root := driftExecution(t, &r.set, ".")
	if root.Status != resultset.StatusCompleted || root.Gate != 0 || root.Outcome != resultset.OutcomeObservationsOnly {
		t.Fatalf("root execution = status %s, gate %d, outcome %s", root.Status, root.Gate, root.Outcome)
	}

	// user.json differs in meaning: a warning with a diff artifact.
	var changed, created []resultset.Finding
	for _, f := range findingsOf(&r.set, "schema.drift") {
		if f.ContextID != root.ContextID {
			continue
		}
		switch *f.RuleID {
		case "schema-drift.changed":
			changed = append(changed, f)
		case "schema-drift.created":
			created = append(created, f)
		}
	}
	if len(changed) != 1 || changed[0].Locations[0].Path != "schemas/user.json" {
		t.Fatalf("drift findings = %+v, want only schemas/user.json: order.json differs in formatting alone", changed)
	}
	f := changed[0]
	if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceConfirmed || f.Gate {
		t.Errorf("finding = %s/%s gate=%v, want a confirmed warning without a Gate", f.Severity, f.Confidence, f.Gate)
	}
	if len(f.Evidence) != 1 || f.Evidence[0].ArtifactID == nil {
		t.Fatalf("evidence = %+v, want the diff linked to an artifact", f.Evidence)
	}
	var diffPath string
	for _, a := range r.set.Artifacts {
		if a.ID == *f.Evidence[0].ArtifactID {
			diffPath = a.Path
		}
	}
	if !strings.HasPrefix(diffPath, "artifacts/schema.drift/"+root.ContextID+"/") || !strings.HasSuffix(diffPath, "-user.json.diff") {
		t.Fatalf("diff artifact path = %q", diffPath)
	}
	diff, err := os.ReadFile(filepath.Join(r.reportDir, diffPath))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--- a/schemas/user.json", "+++ b/schemas/user.json", `+    "email"`} {
		if !strings.Contains(string(diff), want) {
			t.Errorf("diff lacks %q:\n%s", want, diff)
		}
	}
	if strings.Contains(string(diff), "order.json") {
		t.Errorf("the formatting-only file is in the diff:\n%s", diff)
	}
	// The generator also writes a file the project does not commit.
	if len(created) != 1 || created[0].Severity != resultset.SeverityNote || created[0].Evidence[0].Text != "schemas/index.json" {
		t.Errorf("created findings = %+v, want one note for schemas/index.json", created)
	}

	// The nested package's generator needs the network and fails.
	legacy := driftExecution(t, &r.set, "tools/legacy")
	if legacy.Status != resultset.StatusPartial || legacy.ReasonCode == nil || *legacy.ReasonCode != "generator_failed" {
		t.Fatalf("legacy execution = status %s reason %v, want partial with generator_failed", legacy.Status, legacy.ReasonCode)
	}
	var failed []resultset.Finding
	for _, f := range findingsOf(&r.set, "schema.drift") {
		if f.ContextID == legacy.ContextID {
			failed = append(failed, f)
		}
	}
	if len(failed) != 1 || *failed[0].RuleID != "schema-drift.generator-failed" || failed[0].Severity != resultset.SeverityWarning ||
		failed[0].Locations[0].Path != "tools/legacy/package.json" {
		t.Fatalf("legacy findings = %+v, want one generator-failed warning at its package.json", failed)
	}
	if ev := failed[0].Evidence[0]; ev.Trust != resultset.TrustUntrusted || !strings.Contains(ev.Text, "cannot download the legacy schema") {
		t.Errorf("evidence = %+v, want the generator's output", ev)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestTheSchemaDriftPartCountsTheDriftedFilesAndAFailingGeneratorMakesItUnknown(t *testing.T) {
	// Without the nested package, only the stale file is left.
	original := copyProject(t, "schema-drift")
	if err := os.RemoveAll(filepath.Join(original, "tools")); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "benchmark", original, "--only", "schema.drift")

	var part *resultset.BenchmarkPart
	for i := range r.set.Benchmark.Areas {
		for j := range r.set.Benchmark.Areas[i].Parts {
			if p := &r.set.Benchmark.Areas[i].Parts[j]; p.ID == "schema_drift" {
				part = p
			}
		}
	}
	if part == nil || part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue != 1 {
		t.Fatalf("Schema drift part = %+v, want measured with one drifted file", part)
	}

	with := realRun(t, context.Background(), "benchmark", copyProject(t, "schema-drift"), "--only", "schema.drift")
	for i := range with.set.Benchmark.Areas {
		for j := range with.set.Benchmark.Areas[i].Parts {
			if p := &with.set.Benchmark.Areas[i].Parts[j]; p.ID == "schema_drift" {
				if p.State != resultset.PartUnknown || p.Reason == nil || *p.Reason != "partial: generator_failed" {
					t.Errorf("with the failing generator: state %s reason %v, want unknown: partial: generator_failed", p.State, p.Reason)
				}
				return
			}
		}
	}
	t.Error("the Schema drift part is missing from the second Run")
}
