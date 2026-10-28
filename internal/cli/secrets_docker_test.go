//go:build docker

package cli_test

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The values below are invented and open nothing. They are the ones in the
// fake-secret testdata project.
var fakeSecrets = []string{
	"ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA",                  // Source code
	"sk_prod_51Hq9ZtLmNvXw3RbKd8YcFgPa7JeUo2VnSi4TxCzMh6QlWrEy", // Test data
	"Qk4-made-up-npmrc-token-7f3a91",                            // .npmrc
}

// assertNoSecretInReportFolder walks every file of the report folder, the
// Report and its artifacts, and fails when one holds a secret value.
func assertNoSecretInReportFolder(t *testing.T, dir string) {
	t.Helper()
	assertValuesInNoReportFile(t, dir, fakeSecrets)
}

// assertValuesInNoReportFile walks every file of the report folder and fails
// when one holds one of the values.
func assertValuesInNoReportFile(t *testing.T, dir string, values []string) {
	t.Helper()
	files := 0
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		files++
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, s := range values {
			if strings.Contains(string(data), s) {
				rel, _ := filepath.Rel(dir, p)
				t.Errorf("%s holds the secret value %q", rel, s[:8]+"...")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files < 2 {
		t.Fatalf("only %d file(s) in the report folder", files)
	}
}

func secretsExecution(s *resultset.Set) *resultset.Execution {
	for i := range s.Checks {
		if s.Checks[i].CheckID == "security.secrets" {
			return &s.Checks[i]
		}
	}
	return nil
}

// brokenFixtureEvidence returns the text node --check quoted for the broken
// Test data file, which holds both the secrets and the .npmrc token.
func brokenFixtureEvidence(t *testing.T, s *resultset.Set) string {
	t.Helper()
	for _, f := range findingsOf(s, "syntax.parse") {
		if len(f.Locations) > 0 && f.Locations[0].Path == "test/fixtures/broken.js" {
			var texts []string
			for _, ev := range f.Evidence {
				texts = append(texts, ev.Text)
			}
			return strings.Join(texts, "\n")
		}
	}
	t.Fatal("no syntax.parse Finding for test/fixtures/broken.js")
	return ""
}

// Seam A: a whole Run on the fake-secret testdata project, seen through the
// files of the report folder.
func TestSecretsAreSuspectedAndTheirValuesAppearInNoReportFile(t *testing.T) {
	original := copyProject(t, "fake-secret")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original)
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0 (secrets are suspicions, not Gates)\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertPlainProgress(t)
	r.assertNothingLeft(t)
	if treeFingerprint(t, original) != before {
		t.Error("the Original changed")
	}

	e := secretsExecution(&r.set)
	if e == nil || !e.Selected || e.Status != resultset.StatusCompleted || e.ContextID != "C-0001" {
		t.Fatalf("security.secrets execution = %+v", e)
	}
	if e.Tool == nil || e.Tool.Name != "gitleaks" || len(e.Command) == 0 || e.Command[0] != "gitleaks" {
		t.Errorf("tool = %+v, command = %v", e.Tool, e.Command)
	}

	found := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "security.secrets") {
		if f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceSuspected || f.Gate {
			t.Errorf("%s: severity/confidence/gate = %s/%s/%v, want error/suspected/no Gate", f.ID, f.Severity, f.Confidence, f.Gate)
		}
		found[f.Locations[0].Path] = f
	}
	src, ok := found["src/index.js"]
	if !ok || src.InTestData || *src.RuleID != "github-pat" || src.Locations[0].Start.Line != 2 {
		t.Errorf("Source code Finding = %+v", src)
	}
	data, ok := found["test/fixtures/creds.json"]
	if !ok || !data.InTestData || *data.RuleID != "stripe-access-token" {
		t.Errorf("Test data Finding = %+v", data)
	}

	// The project's own gitleaks config and ignore file changed nothing, and
	// the scan is in the project Context's tool list with its digest.
	var tool *resultset.ToolRef
	for i, tr := range r.set.Contexts[0].Tools {
		if tr.Name == "gitleaks" {
			tool = &r.set.Contexts[0].Tools[i]
		}
	}
	if tool == nil || tool.Digest == nil || !strings.HasPrefix(*tool.Digest, "sha256:") {
		t.Errorf("project Context tools = %+v", r.set.Contexts[0].Tools)
	}

	// Redaction applied, and it caught the values another Check quoted.
	red := r.set.ReportCompleteness.Redaction
	if !red.Applied || red.Count < 2 || red.Reason != nil {
		t.Errorf("redaction = %+v", red)
	}
	if ev := brokenFixtureEvidence(t, &r.set); !strings.Contains(ev, "[REDACTED]") {
		t.Errorf("the quoted line is not redacted: %q", ev)
	}
	assertNoSecretInReportFolder(t, r.reportDir)
}

// With security.secrets deselected the scan still runs for redaction, but its
// Findings are not reported.
func TestADeselectedSecretCheckReportsNothingButRedactionStillApplies(t *testing.T) {
	original := copyProject(t, "fake-secret")

	r := realRun(t, context.Background(), "test", original, "--exclude", "security.secrets")
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)

	e := secretsExecution(&r.set)
	if e == nil || e.Selected || e.Status != resultset.StatusNotStarted {
		t.Fatalf("security.secrets execution = %+v, want not selected and not started", e)
	}
	if n := len(findingsOf(&r.set, "security.secrets")); n != 0 {
		t.Errorf("%d security.secrets Finding(s) reported for a deselected Check", n)
	}
	if got := r.set.Selection.PrerequisitesRun; len(got) != 1 || got[0] != "security.secrets" {
		t.Errorf("prerequisites_run = %v", got)
	}
	red := r.set.ReportCompleteness.Redaction
	if !red.Applied || red.Count < 2 {
		t.Errorf("redaction = %+v, want applied", red)
	}
	if ev := brokenFixtureEvidence(t, &r.set); !strings.Contains(ev, "[REDACTED]") {
		t.Errorf("the quoted line is not redacted: %q", ev)
	}
	assertNoSecretInReportFolder(t, r.reportDir)
}

func TestARunOfOnlyOtherChecksRedactsToo(t *testing.T) {
	original := copyProject(t, "fake-secret")
	r := realRun(t, context.Background(), "test", original, "--only", "syntax.parse")
	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if !r.set.ReportCompleteness.Redaction.Applied {
		t.Errorf("redaction = %+v", r.set.ReportCompleteness.Redaction)
	}
	assertNoSecretInReportFolder(t, r.reportDir)
}
