package render_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// A Flaky test Finding lists the outcome, attempts and error of every run as
// Evidence, and the native command that runs the one test.

const (
	runOne   = "run 1 (first run): passed"
	runTwo   = "run 2: failed, 1 attempt\n  attempt 1 (final): failed: counter was 2 and not 1"
	runThree = "run 3: passed after 2 attempts\n  attempt 1: failed: socket hang up\n  attempt 2 (final): passed"
)

func flakyFinding(f *resultset.Finding) {
	f.Confidence = resultset.ConfidenceConfirmed
	f.Title = "Flaky test: counter resets once (runs: passed, failed, passed after 2 attempts)"
	f.Message = "The test passed in 2 of 3 runs."
	for _, text := range []string{runOne, runTwo, runThree} {
		f.Evidence = append(f.Evidence, resultset.Evidence{Kind: "test_run", Text: text, Origin: "mocha", Trust: resultset.TrustUntrusted})
	}
	f.Reproduction.Test = &resultset.TestRepro{
		Runner: "mocha", File: "test/counter.test.js", FullTitle: "counter resets once",
		NativeCommand: []string{"npx", "mocha", "--fgrep", "counter resets once", "test/counter.test.js"},
	}
}

func flakySet(t *testing.T) *resultset.Set {
	t.Helper()
	return benchmarkSet(t, func(p *resultsettest.Project) {
		p.Add("tests.flaky", "flaky-test", false, flakyFinding)
	})
}

func TestTheJSONReportHoldsTheOutcomeOfEveryRunAsEvidenceAndValidates(t *testing.T) {
	s := flakySet(t)
	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("report.json does not validate: %v", problems)
	}
	var doc struct {
		Findings []struct {
			CheckID  string `json:"check_id"`
			Severity string `json:"severity"`
			Gate     bool   `json:"gate"`
			Evidence []struct {
				Kind, Text, Trust string
			} `json:"evidence"`
			Reproduction struct {
				Test struct {
					NativeCommand []string `json:"native_command"`
				} `json:"test"`
			} `json:"reproduction"`
		} `json:"findings"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, f := range doc.Findings {
		if f.CheckID != "tests.flaky" {
			continue
		}
		found = true
		if f.Severity != "warning" || f.Gate {
			t.Errorf("severity = %s, gate = %v, want a warning without a Gate", f.Severity, f.Gate)
		}
		if len(f.Evidence) != 3 {
			t.Fatalf("evidence items = %d, want one per run", len(f.Evidence))
		}
		for i, want := range []string{runOne, runTwo, runThree} {
			if f.Evidence[i].Text != want || f.Evidence[i].Trust != "untrusted_data" {
				t.Errorf("evidence %d = %+v, want %q as untrusted data", i, f.Evidence[i], want)
			}
		}
		if got := strings.Join(f.Reproduction.Test.NativeCommand, " "); got != "npx mocha --fgrep counter resets once test/counter.test.js" {
			t.Errorf("native command = %q", got)
		}
	}
	if !found {
		t.Fatal("no tests.flaky Finding in report.json")
	}
}

func TestTheMarkdownListsTheFlakyTestWithTheOutcomeOfEveryRunInItsTitle(t *testing.T) {
	// report.md lists a Finding that is no Gate in one line. The title carries
	// the outcome of every run, so a reader sees the three at a glance; the
	// evidence of each run is in report.json.
	md := string(render.Markdown(flakySet(t)))

	for _, want := range []string{
		"#### tests.flaky",
		"[warning] `src/a.js:1`: Flaky test: counter resets once (runs: passed, failed, passed after 2 attempts)",
		"Flaky tests",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("report.md lacks %q:\n%s", want, md)
		}
	}
}
