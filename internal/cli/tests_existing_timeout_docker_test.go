//go:build docker

package cli_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A suite that hangs is stopped when the Budget ends. What the reporter wrote
// before that stays in the Report, and the test that never finished is never_run.
func TestAHangingSuiteKeepsItsRecordedResultsWhenTheBudgetEnds(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{
		"test/hangs.test.js": "'use strict';\n\ndescribe('hangs', function () {\n  this.timeout(0);\n\n  it('never ends', () => new Promise(() => {}));\n});\n",
	})

	// The last 60 seconds of a Budget are kept for the Report, which leaves
	// 20 seconds for the install and the suite.
	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing", "--budget", "80s")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusBudgetExhausted || e.Outcome == resultset.OutcomePassed {
		t.Fatalf("tests.existing = %+v, want budget_exhausted and not passed", e)
	}
	if got := passedTitles(t, r, e); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("the result recorded before the Budget ended is kept: passed = %v", got)
	}
	cases := testCasesOf(&r.set, e.ID)
	if len(cases) != 1 || cases[0].FullTitle != "hangs never ends" || cases[0].Outcome != resultset.TestNeverRun ||
		cases[0].NeverRunReason == nil || !strings.Contains(*cases[0].NeverRunReason, "stopped") {
		t.Errorf("test cases = %+v", cases)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 2, Run: 1, Passed: 1, NeverRun: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	r.assertNothingLeft(t)
}
