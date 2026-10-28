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

// repository.gitlab-ci is native, but the Run around it still goes through the
// whole command, so these tests sit at seam A with the other Docker tests.

func TestBrokenGitlabCIFilesFailTheRunAndAnUnresolvedIncludeIsALimitation(t *testing.T) {
	original := copyProject(t, "ci-files")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "repository.gitlab-ci")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := executionOf(t, &r.set, "repository.gitlab-ci")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" {
		t.Fatalf("execution = status %s outcome %s context %s", e.Status, e.Outcome, e.ContextID)
	}

	// The schema error is a Gate. The local include and the !reference are fine.
	schema := ruleFindings(&r.set, "repository.gitlab-ci", "gitlab-ci.schema")
	if len(schema) != 1 || !schema[0].Gate || schema[0].Locations[0].Path != ".gitlab-ci.yml" || schema[0].Locations[0].Start.Line != 23 {
		t.Errorf("schema findings = %+v, want one Gate at .gitlab-ci.yml:23 (retry: lots)", schema)
	}
	// The remote include may define the job that needs names, so the typo is a note.
	typo := ruleFindings(&r.set, "repository.gitlab-ci", "gitlab-ci.unknown-job")
	if len(typo) != 1 || typo[0].Gate || typo[0].Severity != resultset.SeverityNote || !strings.Contains(typo[0].Message, "biuld") {
		t.Errorf("needs typo findings = %+v, want one note", typo)
	}
	var limitations []resultset.Limitation
	for _, l := range r.set.Limitations {
		if l.CheckID != nil && *l.CheckID == "repository.gitlab-ci" {
			limitations = append(limitations, l)
		}
	}
	if len(limitations) != 1 || limitations[0].ReasonCode != "include_not_resolved" || !strings.Contains(limitations[0].Message, "https://ci.example.com/templates/shared.yml") {
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

func TestWithoutAnUnresolvedIncludeANeedsTypoIsAGate(t *testing.T) {
	original := copyProject(t, "ci-files")
	ci := filepath.Join(original, ".gitlab-ci.yml")
	data, err := os.ReadFile(ci)
	if err != nil {
		t.Fatal(err)
	}
	without := strings.Replace(string(data), "  - remote: https://ci.example.com/templates/shared.yml\n", "", 1)
	if without == string(data) {
		t.Fatal("the remote include is not in the testdata project")
	}
	if err := os.WriteFile(ci, []byte(without), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "repository.gitlab-ci")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	typo := ruleFindings(&r.set, "repository.gitlab-ci", "gitlab-ci.unknown-job")
	if len(typo) != 1 || !typo[0].Gate || typo[0].Locations[0].Start.Line != 21 {
		t.Errorf("needs typo findings = %+v, want one Gate at line 21 (the remote include line is gone)", typo)
	}
	if r.set.Summary.Gates != 2 {
		t.Errorf("gates = %d, want 2 (the schema error and the typo)", r.set.Summary.Gates)
	}
	for _, l := range r.set.Limitations {
		if l.CheckID != nil && *l.CheckID == "repository.gitlab-ci" {
			t.Errorf("unexpected limitation %+v", l)
		}
	}
}

func TestAMissingLocalIncludeFailsTheRun(t *testing.T) {
	original := copyProject(t, "ci-files")
	if err := os.Remove(filepath.Join(original, "ci", "deployment.yml")); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "repository.gitlab-ci")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	missing := ruleFindings(&r.set, "repository.gitlab-ci", "gitlab-ci.include-missing")
	if len(missing) != 1 || !missing[0].Gate || !strings.Contains(missing[0].Message, "ci/deployment.yml") {
		t.Errorf("missing-include findings = %+v", missing)
	}
}

func TestTheBenchmarkHasAGitlabCIPartAndTheSchemaHashInTheFingerprint(t *testing.T) {
	original := copyProject(t, "ci-files")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "repository.gitlab-ci")

	var part *resultset.BenchmarkPart
	for i := range r.set.Benchmark.Areas {
		for j := range r.set.Benchmark.Areas[i].Parts {
			if p := &r.set.Benchmark.Areas[i].Parts[j]; p.ID == "gitlab_ci" {
				part = p
			}
		}
	}
	if part == nil || part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue != 1 {
		t.Fatalf("GitLab CI part = %+v, want measured with one invalid file", part)
	}
	h := r.set.Benchmark.Fingerprint.Fields.GitLabCISchemaHash
	if h == nil || len(*h) != 64 {
		t.Errorf("schema hash = %v, want a SHA-256", h)
	}
}
