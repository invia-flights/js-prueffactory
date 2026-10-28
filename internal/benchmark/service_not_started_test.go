package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// A suite that may need a compose Service the Run did not start makes
// tests.existing partial with the reason service_not_started. Its failures are
// no Gates, and the Pass rate is not measured: the range covers it, so a
// Service the tool cannot start never lowers a score or fails a Verdict.

func TestAPackageThatMayNeedAServiceThatIsNotStartedHasNoPassRateAndNoVerdictFail(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(suiteFile("test:unit", "test/a.test.js", 4, 4), suiteFile("test:api", "test/b.test.js", 4, 0))
	p.Status("tests.existing", resultset.StatusPartial, "service_not_started")
	p.Add("tests.existing", "test-failed", false, inSuite("test:api"))

	s := score(t, p)
	b := s.Benchmark

	got := part(t, b, "pass_rate")
	if got.State != resultset.PartUnknown || got.Reason == nil || *got.Reason != "partial: service_not_started" {
		t.Errorf("pass rate = %+v, want unknown because of service_not_started", got)
	}
	wantNull(t, "pass rate score", got.Score)
	wantNull(t, "score", b.Score)
	if len(b.GateFindingIDs) != 0 {
		t.Errorf("gates = %v, want none", b.GateFindingIDs)
	}
	if *b.Verdict != resultset.VerdictIncomplete {
		t.Errorf("verdict = %s, want incomplete", *b.Verdict)
	}
	if code := resultset.ExitCode(s); code != resultset.ExitIncomplete {
		t.Errorf("exit code = %d, want %d", code, resultset.ExitIncomplete)
	}
}
