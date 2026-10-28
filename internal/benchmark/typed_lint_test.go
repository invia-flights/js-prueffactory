package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Typed lint part of the Code correctness area is the n_eff of the
// lint.typed Findings in Source code, x50 = 5. Test code is linted and
// reported, and never counts. Expected scores are worked out by hand from
// n_eff = sum over rules of (1 + log2(count)) and S = 100 * 2^(-n_eff / x50).

func withTypedLint() *resultsettest.Project {
	p := resultsettest.ScoredProject()
	p.AddExecution("lint.typed", "C-0002")
	return p
}

func TestTypedLintDampsRepeatedHitsOfOneRuleAndScoresNEffAgainstFive(t *testing.T) {
	p := withTypedLint()
	for i := 0; i < 4; i++ {
		p.Add("lint.typed", "@typescript-eslint/no-floating-promises", false)
	}
	p.Add("lint.typed", "@typescript-eslint/await-thenable", false)
	b := score(t, p).Benchmark

	got := part(t, b, "typed_lint")
	if got.State != resultset.PartMeasured || got.RawUnit != "hits" {
		t.Fatalf("part = %+v, want measured, in hits", got)
	}
	// Four hits of one rule count 1 + log2(4) = 3, the other rule 1: n_eff 4.
	wantScore(t, "raw value", got.RawValue, 5)
	wantScore(t, "n_eff", got.NEff, 4)
	wantScore(t, "part score: 100 * 2^(-4/5)", got.Score, 57.4)
	if got.X50 == nil || *got.X50 != 5 {
		t.Errorf("x50 = %v, want 5", got.X50)
	}
	if len(got.SourceChecks) != 1 || got.SourceChecks[0] != "lint.typed" {
		t.Errorf("source checks = %v", got.SourceChecks)
	}
	found := false
	for _, p := range area(t, b, "code_correctness").Parts {
		found = found || p.ID == "typed_lint"
	}
	if !found {
		t.Errorf("parts of Code correctness = %+v, want typed_lint among them", area(t, b, "code_correctness").Parts)
	}
}

func TestTypedLintFindingsInTestCodeAreReportedButDoNotCount(t *testing.T) {
	p := withTypedLint()
	p.Add("lint.typed", "@typescript-eslint/no-floating-promises", false)
	for i := 0; i < 6; i++ {
		p.Add("lint.typed", "@typescript-eslint/no-misused-promises", false, resultsettest.AtPath("test/a.test.js"), resultsettest.InTestCode)
	}
	got := part(t, score(t, p).Benchmark, "typed_lint")

	// Only the one Source code hit counts: n_eff 1, 100 * 2^(-1/5).
	wantScore(t, "raw value", got.RawValue, 1)
	wantScore(t, "n_eff", got.NEff, 1)
	wantScore(t, "part score", got.Score, 87.1)
}

func TestTypedLintWithHitsOnlyInTestCodeIsMeasuredAndPerfect(t *testing.T) {
	p := withTypedLint()
	p.Add("lint.typed", "@typescript-eslint/await-thenable", false, resultsettest.AtPath("test/a.test.js"), resultsettest.InTestCode)
	got := part(t, score(t, p).Benchmark, "typed_lint")

	if got.State != resultset.PartMeasured {
		t.Fatalf("state = %s, want measured", got.State)
	}
	wantScore(t, "part score", got.Score, 100)
}

func TestTypedLintIsUnknownWhenTheCheckDidNotComplete(t *testing.T) {
	p := withTypedLint()
	p.Status("lint.typed", resultset.StatusUnsupported, "build_step_required")

	if got := part(t, score(t, p).Benchmark, "typed_lint"); got.State != resultset.PartUnknown || got.Score != nil {
		t.Errorf("part = %+v, want unknown without a score", got)
	}
}

func TestTheTypedLintRuleListHashIsPartOfTheFingerprint(t *testing.T) {
	withRules := func(hash string) *resultsettest.Project {
		p := resultsettest.ScoredProject()
		p.Set.Contexts[1].Tools = append(p.Set.Contexts[1].Tools, resultset.ToolRef{Name: "typed-lint-rules", Version: hash[:12], Digest: &hash})
		return p
	}
	a := "ab" + resultsettest.SHA[2:]
	base := fingerprintOf(t, withRules(a))

	if base.Fields.TypedLintRulesHash == nil || *base.Fields.TypedLintRulesHash != a {
		t.Errorf("typed lint rules hash = %v, want %s", base.Fields.TypedLintRulesHash, a)
	}
	if other := fingerprintOf(t, withRules("cd"+resultsettest.SHA[2:])); other.Hash == base.Hash {
		t.Errorf("a different rule list gives the same fingerprint %s", base.Hash)
	}
	if none := fingerprintOf(t, resultsettest.ScoredProject()); none.Fields.TypedLintRulesHash != nil || none.Hash == base.Hash {
		t.Errorf("without a typed lint run: hash %v, fingerprint %s", none.Fields.TypedLintRulesHash, none.Hash)
	}
}
