package redact_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// When the finished Report fails validation, the diagnostics must say which
// field was rewritten and which rule registered the value, and never print the
// value itself.
func TestExplainNamesTheFieldAndTheRuleButNotTheValue(t *testing.T) {
	const value = "hunter2-made-up-value"
	r := redact.New()
	r.AddTextOnlyFrom("env-secret-name (.env DB_PASSWORD)", value)
	r.AddFrom("gitleaks", "ghp_madeUpTokenForTheTest0123456789abcd")

	s := resultsettest.Populated()
	s.Findings[0].Title = "login with " + value
	s.Findings[0].Message = "token ghp_madeUpTokenForTheTest0123456789abcd leaked"
	s.Checks[0].Reason = ptr("fine")
	if n := r.Apply(s); n != 2 {
		t.Fatalf("Apply replaced %d values, want 2", n)
	}

	lines := r.Explain([]string{
		"/findings/0/title: something is wrong",
		"/findings/0/locations/0/path_base: value must be 'project_root'",
		"/checks/0/reason: another problem",
		"execution number 1 has ID \"x\", want \"E-0001\"", // a consistency problem without a path
	})
	text := strings.Join(lines, "\n")

	for _, want := range []string{"/findings/0/title", "env-secret-name (.env DB_PASSWORD)"} {
		if !strings.Contains(text, want) {
			t.Errorf("the explanation lacks %q:\n%s", want, text)
		}
	}
	for _, l := range lines {
		// Redaction never touched path_base, so the only line about it may say so.
		if strings.Contains(l, "path_base") && !strings.Contains(l, "did not rewrite") {
			t.Errorf("path_base was never rewritten but the explanation blames redaction: %s", l)
		}
	}
	for _, secret := range []string{value, "ghp_madeUpToken"} {
		if strings.Contains(text, secret) {
			t.Errorf("the explanation prints a secret value:\n%s", text)
		}
	}
	for _, l := range lines {
		if strings.Contains(l, "/checks/0/reason") && !strings.Contains(l, "did not rewrite") {
			t.Errorf("redaction did not touch /checks/0/reason but the explanation blames it: %s", l)
		}
	}
	if !strings.Contains(text, "gitleaks") {
		t.Errorf("the summary of rules that replaced values lacks gitleaks:\n%s", text)
	}
}

func TestExplainGroupsTheProblemsOfOneFieldAcrossArrayIndexes(t *testing.T) {
	r := redact.New()
	r.AddTextOnlyFrom(".npmrc", "madeup-registry-token")
	s := resultsettest.Populated()
	s.Findings = append(s.Findings, s.Findings[0], s.Findings[0])
	for i := range s.Findings {
		s.Findings[i].Title = "uses madeup-registry-token"
	}
	r.Apply(s)

	lines := r.Explain([]string{"/findings/0/title: x", "/findings/1/title: x", "/findings/2/title: x"})
	if len(lines) > 3 {
		t.Errorf("three problems in one field should be one line plus a summary, got %d lines:\n%s", len(lines), strings.Join(lines, "\n"))
	}
	if text := strings.Join(lines, "\n"); !strings.Contains(text, "/findings/*/title") || !strings.Contains(text, "3") || !strings.Contains(text, ".npmrc") {
		t.Errorf("explanation = %s", text)
	}
}

func TestExplainSaysSoWhenRedactionTouchedNoneOfTheFailingFields(t *testing.T) {
	r := redact.New()
	r.AddFrom("gitleaks", "madeup-token-never-in-report")
	s := resultsettest.Populated()
	r.Apply(s)
	text := strings.Join(r.Explain([]string{"/findings/0/title: x"}), "\n")
	if !strings.Contains(text, "did not rewrite") {
		t.Errorf("explanation = %q", text)
	}
	if got := redact.New().Explain([]string{"/findings/0/title: x"}); len(got) != 0 {
		t.Errorf("a Redactor without values explains %v, want nothing", got)
	}
}
