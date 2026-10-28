package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Settings that hide results: bail is switched off and the Report says when
// the project's configuration had set it, every retry attempt is recorded, and
// a count the reporter could not see in full is marked as a lower bound.

func limitationsWith(ls []resultset.Limitation, code string) []resultset.Limitation {
	var out []resultset.Limitation
	for _, l := range ls {
		if l.ReasonCode == code {
			out = append(out, l)
		}
	}
	return out
}

func TestABailSettingOfTheProjectsConfigIsListedAsAnOverride(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(`{"ev":"config","bail":true}`, foundAdd, passedAdd, endOfSuite))

	got := limitationsWith(in.eventLimitations(ev), "test_command_override")

	if len(got) != 1 || !strings.Contains(got[0].Message, "bail") || !strings.Contains(got[0].Message, "configuration") ||
		got[0].CheckID == nil || *got[0].CheckID != "tests.existing" || got[0].Path == nil || *got[0].Path != "package.json" {
		t.Errorf("limitations = %+v, want one bail override that names the configuration", got)
	}
}

func TestNoOverrideIsListedWhenTheProjectsConfigDoesNotSetBailOrSaysNothing(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	for name, data := range map[string][]byte{
		"bail false":       lines(`{"ev":"config","bail":false}`, foundAdd, passedAdd, endOfSuite),
		"no config event":  lines(foundAdd, passedAdd, endOfSuite),
		"no events at all": nil,
	} {
		if got := in.eventLimitations(parseTestEvents(data)); len(got) != 0 {
			t.Errorf("%s: limitations = %+v, want none", name, got)
		}
	}
}

func TestACountThatMochaCouldNotSeeIsMarkedAsALowerBoundWithALimitation(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(`{"ev":"partial","reason":"parallel"}`, passedAdd, endOfSuite))

	got := limitationsWith(in.eventLimitations(ev), "test_counts_lower_bound")

	if len(got) != 1 || got[0].CheckID == nil || *got[0].CheckID != "tests.existing" ||
		!strings.Contains(got[0].Message, "lower bound") || !strings.Contains(got[0].Message, "parallel") {
		t.Errorf("limitations = %+v, want one lower-bound limitation that names the parallel mode", got)
	}
}

func TestEveryRetryAttemptIsRecordedAndATestThatFailsAfterRetriesKeepsThemAll(t *testing.T) {
	in := suiteInput(t, map[string]string{"test/add.test.js": "x"})
	ev := parseTestEvents(lines(
		foundAdd,
		`{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"attempt 1"}}`,
		`{"ev":"retry","id":1,"duration":5,"err":{"name":"Error","message":"attempt 2"}}`,
		`{"ev":"result","id":1,"outcome":"failed","duration":6,"err":{"name":"Error","message":"attempt 3"}}`,
		endOfSuite,
	))

	r := in.suiteResults(ev, mochaNative)

	c := caseOf(t, r, "add adds")
	if c.Outcome != resultset.TestFailed || c.Flaky || len(c.Attempts) != 3 {
		t.Fatalf("case = %+v, want failed, not flaky, three attempts", c)
	}
	for i, want := range []string{"attempt 1", "attempt 2", "attempt 3"} {
		a := c.Attempts[i]
		if a.Outcome != resultset.TestFailed || a.Error == nil || *a.Error != want || a.DurationMS != int64(4+i) {
			t.Errorf("attempt %d = %+v, want failed %q after %d ms", i+1, a, want, 4+i)
		}
	}
	if len(r.Findings) != 1 {
		t.Errorf("a test that fails after its retries is one Finding: %+v", r.Findings)
	}
}
