package engine

import (
	"bytes"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

const testSecret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA" // made up

func newTestRun(log *bytes.Buffer) *run {
	return &run{log: progress.New(log, nil), redactor: redact.New()}
}

func scanResult(prereq bool, status resultset.ExecStatus) *execResult {
	entry, _ := checks.Lookup(checks.SecretsCheckID)
	p := &planned{key: "x1", entry: entry, deselected: prereq, prerequisite: prereq,
		context: &discovery.Context{Context: resultset.Context{ID: "C-0001"}}}
	e := newExec(p)
	e.Status = status
	return &execResult{
		p: p, exec: e, redact: []string{testSecret},
		findings: []resultset.Finding{{ID: "f1"}}, metrics: []resultset.Metric{{ID: "m1"}},
	}
}

func TestADeselectedSecretScanStillFeedsRedactionButReportsNothing(t *testing.T) {
	var log bytes.Buffer
	r := newTestRun(&log)
	got := r.takeSecretScan(scanResult(true, resultset.StatusCompleted))

	if got.exec.Selected || got.exec.Status != resultset.StatusNotStarted || len(got.findings) != 0 || len(got.metrics) != 0 {
		t.Errorf("a deselected scan must report as not started without Findings: %+v", got.exec)
	}
	if got.exec.ReasonCode == nil || *got.exec.ReasonCode != "deselected" {
		t.Errorf("reason code = %v", got.exec.ReasonCode)
	}
	if len(r.prerequisites) != 1 || r.prerequisites[0] != checks.SecretsCheckID {
		t.Errorf("prerequisites = %v", r.prerequisites)
	}
	if s, _ := r.redactor.String("x " + testSecret); strings.Contains(s, testSecret) {
		t.Error("the value found by the deselected scan is not redacted")
	}
}

func TestASelectedSecretScanKeepsItsResult(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	res := scanResult(false, resultset.StatusCompleted)
	if got := r.takeSecretScan(res); got != res || len(got.findings) != 1 {
		t.Error("the selected scan's result must pass through")
	}
	if len(r.prerequisites) != 0 {
		t.Errorf("prerequisites = %v", r.prerequisites)
	}
}

func TestOtherChecksAreNotTouchedByTheSecretHook(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	entry, _ := checks.Lookup("syntax.parse")
	res := &execResult{p: &planned{entry: entry}, redact: []string{testSecret}}
	if got := r.takeSecretScan(res); got != res || r.redactor.Len() != 0 {
		t.Error("only the secret scan feeds redaction")
	}
}

func TestRedactionOutcome(t *testing.T) {
	done := secretScan{seen: true, status: resultset.StatusCompleted}
	if got := redactionOutcome(done, "", 3); !got.Applied || got.Count != 3 || got.Reason != nil {
		t.Errorf("completed scan: %+v", got)
	}
	failed := secretScan{seen: true, status: resultset.StatusToolError}
	got := redactionOutcome(failed, "gitleaks exited with 1", 1)
	if got.Applied || got.Count != 1 || got.Reason == nil ||
		!strings.Contains(*got.Reason, "tool_error") || !strings.Contains(*got.Reason, "gitleaks exited with 1") {
		t.Errorf("failed scan: %+v", got)
	}
	if got := redactionOutcome(secretScan{}, "", 0); got.Applied || got.Reason == nil {
		t.Errorf("no scan: %+v", got)
	}
}

func TestAFailedScanWarnsOnStderrAndLeavesRedactionNotApplied(t *testing.T) {
	var log bytes.Buffer
	r := newTestRun(&log)
	r.takeSecretScan(&execResult{
		p:      &planned{entry: mustEntry(t, checks.SecretsCheckID)},
		exec:   resultset.Execution{Status: resultset.StatusInfrastructureError, Reason: ptr("docker said " + testSecret)},
		redact: []string{testSecret},
	})
	set := &resultset.Set{}
	r.redactSet(set)

	red := set.ReportCompleteness.Redaction
	if red.Applied || red.Reason == nil || !strings.Contains(*red.Reason, "infrastructure_error") {
		t.Fatalf("redaction = %+v", red)
	}
	if strings.Contains(*red.Reason, testSecret) || strings.Contains(log.String(), testSecret) {
		t.Errorf("the reason or the warning leaks the value:\n%s\n%s", *red.Reason, log.String())
	}
	if !strings.Contains(log.String(), "warning: secret redaction is incomplete") {
		t.Errorf("stderr has no warning:\n%s", log.String())
	}
}

func projectWithEnv() *discovery.Project {
	return &discovery.Project{
		DotEnv: map[string]string{"GREETING": "hello", "DB_HOST": "db.internal.example", "DB_PASSWORD": "pw-for-tests"},
		Services: []discovery.ComposeService{{
			Name: "billing", Family: "postgres",
			Env: map[string]string{"POSTGRES_PASSWORD": "pw-for-tests", "POSTGRES_DB": "billing", "GREETING": "hello"},
		}},
	}
}

// Only values that look like secrets by redact.EnvRule are redacted. An
// ordinary value stays readable, in a path or a Service name as much as in text.
func TestOnlyEnvValuesThatLookLikeSecretsAreRedacted(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	r.proj = projectWithEnv()
	r.collectServiceSecrets()

	set := &resultset.Set{
		Services: []resultset.Service{{Family: "postgres", ComposeService: "billing", Reason: ptr("billing db said hello with pw-for-tests")}},
		Findings: []resultset.Finding{{
			Title: "hello pw-for-tests", Locations: []resultset.Location{{Path: "src/hello/pw-for-tests.js"}},
		}},
	}
	r.redactSet(set)

	if got := *set.Services[0].Reason; got != "billing db said hello with [REDACTED]" {
		t.Errorf("service reason = %q", got)
	}
	if set.Services[0].ComposeService != "billing" {
		t.Errorf("compose service = %q", set.Services[0].ComposeService)
	}
	f := set.Findings[0]
	if f.Title != "hello [REDACTED]" || f.Locations[0].Path != "src/hello/pw-for-tests.js" {
		t.Errorf("finding = %+v", f)
	}
	if got := r.redactText("raw log hello pw-for-tests"); got != "raw log hello [REDACTED]" {
		t.Errorf("redactText = %q", got)
	}
}

// The Report says which rule decided, and which variables it left readable.
func TestTheReportNamesTheEnvRuleAndWhatItLeftReadable(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	r.proj = projectWithEnv()
	r.collectServiceSecrets()
	set := &resultset.Set{}
	r.redactSet(set)

	var got []resultset.Limitation
	for _, l := range set.Limitations {
		if l.ReasonCode == "env_values_left_readable" {
			got = append(got, l)
		}
	}
	if len(got) != 1 {
		t.Fatalf("limitations = %+v", set.Limitations)
	}
	m := got[0].Message
	if !strings.Contains(m, redact.EnvRule) {
		t.Errorf("message does not state the rule: %s", m)
	}
	for _, name := range []string{"GREETING", "DB_HOST", "POSTGRES_DB"} {
		if !strings.Contains(m, name) {
			t.Errorf("message does not name %s: %s", name, m)
		}
	}
	if strings.Contains(m, "pw-for-tests") || strings.Contains(m, "DB_PASSWORD") || strings.Contains(m, "POSTGRES_PASSWORD") {
		t.Errorf("message names a redacted variable: %s", m)
	}
}

// A placeholder under a secret name is left readable: the word stays in a text
// such as a test title, and the Limitation names the placeholder rule and the
// variable.
func TestAPlaceholderUnderASecretNameStaysReadableAndTheLimitationSaysWhy(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	r.proj = &discovery.Project{DotEnv: map[string]string{"SOME_SECRET_KEY": "empty", "STORE_TOKEN": testSecret}}
	r.collectServiceSecrets()
	set := &resultset.Set{Findings: []resultset.Finding{{Title: "answers an empty list with " + testSecret}}}
	r.redactSet(set)

	if got := set.Findings[0].Title; got != "answers an empty list with [REDACTED]" {
		t.Errorf("title = %q", got)
	}
	var message string
	for _, l := range set.Limitations {
		if l.ReasonCode == "env_values_left_readable" {
			message = l.Message
		}
	}
	if !strings.Contains(message, "placeholder") || !strings.Contains(message, "SOME_SECRET_KEY") || strings.Contains(message, "STORE_TOKEN") {
		t.Errorf("message = %q", message)
	}
}

func TestNoLimitationWhenTheRuleLeftNothingReadable(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	r.proj = &discovery.Project{DotEnv: map[string]string{"DB_PASSWORD": "pw-for-tests"}}
	r.collectServiceSecrets()
	set := &resultset.Set{}
	r.redactSet(set)
	if len(set.Limitations) != 0 {
		t.Errorf("limitations = %+v", set.Limitations)
	}
}

func TestAnIncompleteRedactionReasonNamesTheRule(t *testing.T) {
	got := redactionOutcome(secretScan{}, "", 0)
	if got.Reason == nil || !strings.Contains(*got.Reason, "look like secrets") {
		t.Errorf("reason = %v", got.Reason)
	}
}

// A Report that fails its validation after redaction says which fields
// redaction rewrote and which rule registered the values, by name and never by
// value. The values come from the secret scan, an .npmrc file and the .env file.
func TestAnInvalidReportNamesTheRulesThatRewroteItsFields(t *testing.T) {
	r := newTestRun(&bytes.Buffer{})
	r.proj = &discovery.Project{DotEnv: map[string]string{"DB_PASSWORD": "pw-for-tests"}}
	r.collectServiceSecrets()
	r.takeSecretScan(scanResult(false, resultset.StatusCompleted))
	r.redactor.AddFrom(npmrcSource, "madeup-npm-token")

	set := &resultset.Set{Findings: []resultset.Finding{{
		Title: "pw-for-tests", Message: testSecret + " and madeup-npm-token",
	}}}
	r.redactSet(set)

	err := &writer.InvalidReportError{Path: "/out/report.invalid.json", Problems: []string{
		"/findings/0/title: wrong", "/findings/0/message: wrong",
	}}
	r.explainInvalid(err)

	text := err.Error()
	for _, want := range []string{
		".env env-secret-name (variable DB_PASSWORD)", "gitleaks", ".npmrc", "/findings/0/title", "/findings/0/message",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("message lacks %q:\n%s", want, text)
		}
	}
	for _, secret := range []string{"pw-for-tests", testSecret, "madeup-npm-token"} {
		if strings.Contains(text, secret) {
			t.Errorf("message shows a secret value:\n%s", text)
		}
	}
}

func mustEntry(t *testing.T, id string) checks.Entry {
	t.Helper()
	e, ok := checks.Lookup(id)
	if !ok {
		t.Fatalf("no Check %s", id)
	}
	return e
}

func ptr[T any](v T) *T { return &v }
