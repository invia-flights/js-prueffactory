//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of tests.existing for Mocha settings that would hide results:
// bail, retries and .only. The Report shows every failure, every retry attempt
// and the tests a .only excluded.

// passedCasesOf reads the artifact of passed test cases of an execution.
func passedCasesOf(t *testing.T, r *dockerRun, e resultset.Execution) []struct {
	FullTitle string                  `json:"full_title"`
	Flaky     bool                    `json:"flaky"`
	Attempts  []resultset.TestAttempt `json:"attempts"`
} {
	t.Helper()
	a := artifactOf(&r.set, e, "tests.existing-"+e.ContextID+"-passed.json")
	if a == nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(a.Path)))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Passed []struct {
			FullTitle string                  `json:"full_title"`
			Flaky     bool                    `json:"flaky"`
			Attempts  []resultset.TestAttempt `json:"attempts"`
		} `json:"passed"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Passed
}

func overrideMessages(s *resultset.Set) string {
	var out []string
	for _, l := range s.Limitations {
		if l.ReasonCode == "test_command_override" {
			out = append(out, l.Message)
		}
	}
	return strings.Join(out, "\n")
}

func TestBailInTheProjectsConfigIsSwitchedOffAndEveryFailureAndRetryAttemptIsRecorded(t *testing.T) {
	original := copyProject(t, "bail-and-retries")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed {
		t.Errorf("tests.existing = %+v", e)
	}
	// The project's config says bail: true, and the Report lists the override.
	if got := overrideMessages(&r.set); !strings.Contains(got, "configuration sets bail") {
		t.Errorf("overrides = %q, want the bail setting of the configuration listed", got)
	}
	// Both failures are Findings, although the first one would have stopped the run.
	var titles []string
	for _, f := range findingsOf(&r.set, "tests.existing") {
		titles = append(titles, f.Title)
	}
	if len(titles) != 2 || !strings.Contains(titles[0]+titles[1], "failures fails first") ||
		!strings.Contains(titles[0]+titles[1], "failures fails on every attempt") {
		t.Errorf("findings = %q, want both failures", titles)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 5, Run: 5, Passed: 3, Failed: 2}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	// A test that failed after its retries keeps every attempt.
	var retried *resultset.TestCase
	for _, tc := range testCasesOf(&r.set, e.ID) {
		if tc.FullTitle == "failures fails on every attempt" {
			retried = &tc
		}
	}
	if retried == nil || retried.Outcome != resultset.TestFailed || retried.Flaky || len(retried.Attempts) != 3 {
		t.Fatalf("retried test = %+v, want failed, not flaky, three attempts", retried)
	}
	for i, a := range retried.Attempts {
		if a.Outcome != resultset.TestFailed || a.Error == nil || !strings.Contains(*a.Error, "Expected values to be strictly equal") {
			t.Errorf("attempt %d = %+v", i+1, a)
		}
	}
	// A test that passed on its second attempt is passed, flaky and has both attempts.
	var flaky int
	for _, p := range passedCasesOf(t, r, e) {
		if p.FullTitle == "flaky passes only on its second attempt" {
			flaky++
			if !p.Flaky || len(p.Attempts) != 2 || p.Attempts[0].Outcome != resultset.TestFailed || p.Attempts[0].Error == nil ||
				p.Attempts[1].Outcome != resultset.TestPassed {
				t.Errorf("flaky test = %+v", p)
			}
		} else if p.Flaky || len(p.Attempts) != 1 {
			t.Errorf("%s = %+v, want one attempt and not flaky", p.FullTitle, p)
		}
	}
	if flaky != 1 {
		t.Errorf("passed cases = %+v, want the flaky test once", passedCasesOf(t, r, e))
	}
	r.assertNothingLeft(t)
}

func TestBailInAJavaScriptConfigIsSwitchedOffAndListed(t *testing.T) {
	original := copyProject(t, "bail-and-retries")
	if err := os.Remove(filepath.Join(original, ".mocharc.json")); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, original, map[string]string{
		".mocharc.cjs": "'use strict';\n\nmodule.exports = { spec: ['test/**/*.test.js'], bail: true, exit: true };\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if got := overrideMessages(&r.set); !strings.Contains(got, "configuration sets bail") {
		t.Errorf("overrides = %q, want the bail setting of the JavaScript configuration listed", got)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if got := inventoryOf(t, &r.set, e.ContextID); got.Failed != 2 || got.Found != 5 {
		t.Errorf("inventory = %+v, want every test run in spite of bail", got)
	}
	r.assertNothingLeft(t)
}

func TestNoBailOverrideIsListedWhenTheProjectDoesNotSetBail(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if got := overrideMessages(&r.set); strings.Contains(got, "bail") && strings.Contains(got, "configuration sets bail") {
		t.Errorf("overrides = %q, want no bail override of a configuration that does not set bail", got)
	}
	r.assertNothingLeft(t)
}

func TestTestsExcludedByACommittedOnlyAreFoundAndNeverRunAndTheFocusedOneIsCounted(t *testing.T) {
	original := copyProject(t, "committed-only")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("tests.existing = %+v\nstderr:\n%s", e, r.stderr)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 4, Run: 1, Passed: 1, Focused: 1, NeverRun: 3}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	cases := testCasesOf(&r.set, e.ID)
	if len(cases) != 3 {
		t.Fatalf("test cases = %+v, want the three tests the .only excluded", cases)
	}
	for _, tc := range cases {
		if tc.Outcome != resultset.TestNeverRun || tc.NeverRunReason == nil || !strings.Contains(*tc.NeverRunReason, ".only") {
			t.Errorf("%s = %+v, want never_run because of the .only", tc.FullTitle, tc)
		}
	}
	// Mocha's own filter ran after the reporter was built, so nothing is guessed.
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "test_counts_lower_bound" {
			t.Errorf("limitation = %+v, want none: every test was seen", l)
		}
	}
	r.assertNothingLeft(t)
}

func TestInParallelModeTheCountsAreMarkedAsLowerBoundsWithALimitation(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{
		".mocharc.json":       `{"spec":["test/**/*.test.js"],"parallel":true}` + "\n",
		"test/second.test.js": "'use strict';\n\ndescribe('second', () => {\n  it('also passes', () => {});\n});\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if got := inventoryOf(t, &r.set, e.ContextID); got.Run != 2 || got.Passed != 2 {
		t.Errorf("inventory = %+v, want the two tests that ran", got)
	}
	var found *resultset.Limitation
	for i, l := range r.set.Limitations {
		if l.ReasonCode == "test_counts_lower_bound" {
			found = &r.set.Limitations[i]
		}
	}
	if found == nil || !strings.Contains(found.Message, "lower bound") || found.CheckID == nil || *found.CheckID != "tests.existing" {
		t.Errorf("limitations = %+v, want the lower-bound limitation of tests.existing", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}

// The reporter reads the project's bail setting through Mocha's own option
// loader, which moved in Mocha 12, and follows retried tests through clones.
func TestBailAndRetriesWorkOnEverySupportedMochaMajor(t *testing.T) {
	for _, major := range []string{"9", "10", "11", "12"} {
		t.Run("mocha "+major, func(t *testing.T) {
			original := copyProject(t, "bail-and-retries")
			writeFiles(t, original, map[string]string{
				"package.json": `{"name":"bail-and-retries","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"^` + major + `"}}` + "\n",
			})
			if err := os.Remove(filepath.Join(original, "package-lock.json")); err != nil {
				t.Fatal(err)
			}

			r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

			e := oneExecution(t, &r.set, "tests.existing")
			if e.Status != resultset.StatusCompleted {
				t.Fatalf("tests.existing = %+v\nstderr:\n%s", e, r.stderr)
			}
			if got := overrideMessages(&r.set); !strings.Contains(got, "configuration sets bail") {
				t.Errorf("overrides = %q, want the bail setting listed", got)
			}
			want := resultset.PackageTests{ContextID: e.ContextID, Found: 5, Run: 5, Passed: 3, Failed: 2}
			if got := inventoryOf(t, &r.set, e.ContextID); got != want {
				t.Errorf("inventory = %+v, want %+v", got, want)
			}
			flaky := 0
			for _, p := range passedCasesOf(t, r, e) {
				if p.Flaky && len(p.Attempts) == 2 {
					flaky++
				}
			}
			if flaky != 1 {
				t.Errorf("flaky passed cases = %d, want 1", flaky)
			}
			r.assertNothingLeft(t)
		})
	}
}
