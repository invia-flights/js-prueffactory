//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestAWorkflowWithAnActionlintErrorFailsTheRunAndZizmorAndShellCheckGiveWarnings(t *testing.T) {
	original := copyProject(t, "ci-files")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "repository.github-actions")

	if r.code != 1 {
		reason := ""
		if p := executionOf(t, &r.set, "repository.github-actions").Reason; p != nil {
			reason = *p
		}
		t.Fatalf("exit = %d, want 1\nreason: %s\nstderr:\n%s", r.code, reason, r.stderr)
	}
	e := executionOf(t, &r.set, "repository.github-actions")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" || e.Gate != 1 {
		t.Fatalf("execution = status %s outcome %s context %s gates %d (reason %v), want completed, failed, C-0001, 1", e.Status, e.Outcome, e.ContextID, e.Gate, e.Reason)
	}
	if e.Tool == nil || e.Tool.Name != "actionlint" || e.Tool.Version == nil || *e.Tool.Version != "1.7.12" {
		t.Errorf("tool = %+v, want actionlint 1.7.12", e.Tool)
	}
	var tools []string
	for _, c := range r.set.Contexts {
		if c.ID != "C-0001" {
			continue
		}
		for _, tool := range c.Tools {
			if tool.Digest == nil || !strings.HasPrefix(*tool.Digest, "sha256:") {
				t.Errorf("tool %s has no image digest", tool.Name)
			}
			tools = append(tools, tool.Name+" "+tool.Version)
		}
	}
	if !strings.Contains(strings.Join(tools, ","), "actionlint 1.7.12") || !strings.Contains(strings.Join(tools, ","), "zizmor 1.31.1") {
		t.Errorf("tools of the project Context = %v, want actionlint and zizmor", tools)
	}

	byRule := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "repository.github-actions") {
		byRule[*f.RuleID] = f
	}
	needs, ok := byRule["actionlint.job-needs"]
	if !ok || !needs.Gate || needs.Severity != resultset.SeverityError || needs.Locations[0].Path != ".github/workflows/ci.yml" {
		t.Fatalf("job-needs finding = %+v, want a Gate in the workflow", needs)
	}
	if len(needs.Evidence) == 0 || needs.Evidence[0].Trust != resultset.TrustUntrusted || !strings.Contains(needs.Evidence[0].Text, "biuld") {
		t.Errorf("job-needs evidence = %+v, want actionlint's message as untrusted text", needs.Evidence)
	}
	if strings.Contains(needs.Title+needs.Message, "biuld") {
		t.Errorf("the workflow's job name is in a trusted field: %q / %q", needs.Title, needs.Message)
	}

	// ShellCheck's SC2086 comes through actionlint as a warning, not a Gate.
	shell, ok := byRule["actionlint.shellcheck"]
	if !ok || shell.Gate || shell.Severity != resultset.SeverityWarning {
		t.Errorf("shellcheck finding = %+v, want a warning without a Gate", shell)
	}

	// zizmor: the unpinned action is a warning with confidence likely.
	unpinned, ok := byRule["zizmor.unpinned-uses"]
	if !ok || unpinned.Gate || unpinned.Severity != resultset.SeverityWarning || unpinned.Confidence != resultset.ConfidenceLikely {
		t.Errorf("unpinned-uses finding = %+v, want a warning, likely, no Gate", unpinned)
	}
	for _, f := range findingsOf(&r.set, "repository.github-actions") {
		if strings.HasPrefix(*f.RuleID, "zizmor.") && f.Gate {
			t.Errorf("zizmor Finding %s is a Gate", *f.RuleID)
		}
	}
	if r.set.Summary.Gates != 1 {
		t.Errorf("gates = %d, want 1", r.set.Summary.Gates)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestWorkflowsThatAreNotYAMLAreGatesAndZizmorHavingNothingToAuditIsNoFailure(t *testing.T) {
	original := copyProject(t, "ci-files")
	// Replace the workflow with one that no parser reads.
	writeFiles(t, original, map[string]string{".github/workflows/ci.yml": "name: broken\non: [push\njobs:\n  a: [\n"})

	r := realRun(t, context.Background(), "test", original, "--only", "repository.github-actions")

	e := executionOf(t, &r.set, "repository.github-actions")
	if e.Status != resultset.StatusCompleted || e.Gate != 1 {
		t.Fatalf("execution = status %s gates %d (reason %v), want completed with the syntax error as one Gate", e.Status, e.Gate, e.Reason)
	}
	gates := gatesByPath(&r.set, "repository.github-actions")
	if g, ok := gates[".github/workflows/ci.yml"]; !ok || *g.RuleID != "actionlint.syntax-check" {
		t.Errorf("gates = %+v, want actionlint.syntax-check in the workflow", gates)
	}
}

// The project's own configuration of the two tools must not be able to switch
// off the rules that audit its workflows. zizmor reads .github/zizmor.yml of
// the project unless it is told not to. actionlint reads its configuration
// relative to the working directory, so the project's file has no effect today;
// the Check passes an empty one anyway.
func TestTheProjectsOwnToolConfigurationCannotSwitchOffTheGateOrTheWarnings(t *testing.T) {
	original := copyProject(t, "ci-files")
	writeFiles(t, original, map[string]string{
		".github/actionlint.yaml": "paths:\n  .github/workflows/**/*.yml:\n    ignore:\n      - 'does not exist'\n",
		".github/zizmor.yml":      "rules:\n  unpinned-uses:\n    disable: true\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "repository.github-actions")

	if e := executionOf(t, &r.set, "repository.github-actions"); e.Gate != 1 {
		t.Errorf("gates = %d, want the Gate the project's own configuration tried to ignore", e.Gate)
	}
	var unpinned bool
	for _, f := range findingsOf(&r.set, "repository.github-actions") {
		unpinned = unpinned || *f.RuleID == "zizmor.unpinned-uses"
	}
	if !unpinned {
		t.Error("zizmor.unpinned-uses is gone: the project's zizmor.yml was read")
	}
}

func TestTheBenchmarkHasAGitHubActionsPart(t *testing.T) {
	original := copyProject(t, "ci-files")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "repository.github-actions")

	var part *resultset.BenchmarkPart
	for i := range r.set.Benchmark.Areas {
		for j := range r.set.Benchmark.Areas[i].Parts {
			if p := &r.set.Benchmark.Areas[i].Parts[j]; p.ID == "github_actions" {
				part = p
			}
		}
	}
	if part == nil || part.State != resultset.PartMeasured || part.RawValue == nil || *part.RawValue < 2 || part.NEff == nil || *part.NEff <= 0 {
		t.Fatalf("GitHub Actions part = %+v, want measured with the Gate and the warnings counted", part)
	}
}
