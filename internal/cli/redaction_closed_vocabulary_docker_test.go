//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The values of the secret-named variables of the .env file of the
// closed-vocabulary-env testdata project. Each is an ordinary word and also a
// word of the Report's own vocabulary: root is inside the schema constant
// project_root, confirmed is a confidence, primary a location role, parse and
// syntax are inside the Check ID syntax.parse. All made up.
var closedVocabularyValues = []string{"root", "confirmed", "primary", "parse", "syntax"}

// freeTextKeys are the fields of report.json that hold text, where a registered
// value must be redacted.
var freeTextKeys = map[string]bool{
	"title": true, "message": true, "text": true, "reason": true, "expected": true, "actual": true,
	"error": true, "full_title": true,
}

// assertClosedVocabularyIntact checks one Run on the project: the exit code
// follows the normal rule, both reports exist, the closed-vocabulary fields are
// as the code wrote them, and the registered words are redacted in free text.
// (The Report validating is checked by realRun for every Run.)
func assertClosedVocabularyIntact(t *testing.T, r *dockerRun, wantCode int) {
	t.Helper()
	if r.code != wantCode {
		t.Fatalf("exit = %d, want %d (the parse error in Source code is a Gate)\nstderr:\n%s", r.code, wantCode, r.stderr)
	}
	for _, name := range []string{"report.json", "report.md", "report.schema.json"} {
		if _, err := os.Stat(filepath.Join(r.reportDir, name)); err != nil {
			t.Errorf("%s was not written: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(r.reportDir, "report.invalid.json")); err == nil {
		t.Error("report.invalid.json exists, the Report failed its own validation")
	}

	// path_base is the schema constant in every location, whatever the Run found.
	locations := 0
	walkJSON(r.report, "", func(key, v string) {
		if key == "path_base" {
			locations++
			if v != "project_root" {
				t.Errorf("path_base = %q, want project_root", v)
			}
		}
	})
	if locations == 0 {
		t.Error("the Report has no location, so path_base was not checked")
	}

	// The Finding: every closed-vocabulary field as the code wrote it, the path
	// intact (an identifier), and the words redacted in the text.
	found := findingsOf(&r.set, "syntax.parse")
	if len(found) != 1 {
		t.Fatalf("syntax.parse Findings = %+v, want one", found)
	}
	f := found[0]
	if f.Kind != resultset.KindDefect || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed || !f.Gate {
		t.Errorf("finding kind/severity/confidence/gate = %s/%s/%s/%v", f.Kind, f.Severity, f.Confidence, f.Gate)
	}
	if f.CheckID != "syntax.parse" || f.RuleID == nil || *f.RuleID != "SyntaxError" || f.Fingerprint.Algorithm != resultset.FingerprintV1 {
		t.Errorf("finding check/rule/fingerprint = %s/%v/%s", f.CheckID, f.RuleID, f.Fingerprint.Algorithm)
	}
	loc := f.Locations[0]
	if loc.Role != "primary" || loc.PathBase != "project_root" || loc.Path != "src/root-config.js" {
		t.Errorf("location = %+v, want the role, path_base and path as the code wrote them", loc)
	}
	if got := f.Reproduction.VerifiedBy; len(got) != 1 || got[0] != "syntax.parse" {
		t.Errorf("verified_by = %v", got)
	}
	ev := f.Evidence[0]
	if ev.Kind != "tool_output" || ev.Origin != "node --check" || ev.Trust != resultset.TrustUntrusted {
		t.Errorf("evidence kind/origin/trust = %s/%s/%s", ev.Kind, ev.Origin, ev.Trust)
	}
	if f.Title != "JavaScript file does not "+redact.Placeholder {
		t.Errorf("title = %q, want the word parse redacted", f.Title)
	}
	if f.Message != "node --check reports a "+redact.Placeholder+" error in this file." {
		t.Errorf("message = %q, want the word syntax redacted", f.Message)
	}
	if !strings.Contains(ev.Text, redact.Placeholder) {
		t.Errorf("the evidence shows no redaction: %q", ev.Text)
	}
	if f.Locations[0].Snippet != nil {
		if s := f.Locations[0].Snippet.Text; strings.Contains(s, "root") {
			t.Errorf("snippet = %q", s)
		}
	}

	// The execution and the selection.
	e := executionOf(t, &r.set, "syntax.parse")
	if e.Family != "syntax" || e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.Gate != 1 {
		t.Errorf("execution = %+v", e)
	}
	if got := r.set.Selection.EffectiveChecks; len(got) != 1 || got[0] != "syntax.parse" {
		t.Errorf("effective checks = %v", got)
	}

	// No registered word survives in any text of report.json, and the Report
	// says redaction ran.
	walkJSON(r.report, "", func(key, v string) {
		if !freeTextKeys[key] {
			return
		}
		for _, word := range closedVocabularyValues {
			if strings.Contains(v, word) {
				t.Errorf("%s = %q still holds the registered word %q", key, v, word)
			}
		}
	})
	if red := r.set.ReportCompleteness.Redaction; !red.Applied || red.Count < 1 {
		t.Errorf("redaction = %+v", red)
	}
	md, err := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(md), redact.Placeholder) {
		t.Error("report.md shows no redaction")
	}
}

// Seam A: a whole Run on a project whose .env has secret-named variables with
// values such as root. The values are registered and redacted in every text,
// but the fields with a closed vocabulary (path_base is the constant
// project_root, the role, kind, severity, confidence, the Check ID) stay as the
// code wrote them, so the Report validates and the exit code is the Run's
// normal one and not 3 (ticket 38).
func TestARegisteredWordThatIsAlsoASchemaWordLeavesTheClosedVocabularyAlone(t *testing.T) {
	original := copyProject(t, "closed-vocabulary-env")

	r := realRun(t, context.Background(), "test", original, "--only", "syntax.parse")

	assertClosedVocabularyIntact(t, r, 1)
	r.assertNothingLeft(t)
}

// The same on the benchmark command, which writes the benchmark section too.
func TestBenchmarkWithRegisteredSchemaWordsWritesAValidReport(t *testing.T) {
	original := copyProject(t, "closed-vocabulary-env")

	r := realRun(t, context.Background(), "benchmark", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	b := r.set.Benchmark
	if b.Status == "" || b.Verdict == nil || *b.Verdict != resultset.VerdictFail {
		t.Errorf("benchmark = %+v, want a section with the verdict fail (the parse error is a Gate)", b)
	}
	for _, name := range []string{"report.json", "report.md"} {
		if _, err := os.Stat(filepath.Join(r.reportDir, name)); err != nil {
			t.Errorf("%s was not written: %v", name, err)
		}
	}
	walkJSON(r.report, "", func(key, v string) {
		if key == "path_base" && v != "project_root" {
			t.Errorf("path_base = %q, want project_root", v)
		}
	})
	r.assertNothingLeft(t)
}
