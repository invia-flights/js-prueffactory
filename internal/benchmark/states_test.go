package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

var validityChecks = []string{
	"package.manifest", "package.install", "syntax.parse", "artifacts.structured", "api.lint",
	"schema.compile", "repository.helm", "deps.tree", "repository.dockerfile", "repository.shell",
}

func TestAPartThatDoesNotExistIsDroppedAndTheAreaKeepsItsOtherParts(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	for _, id := range []string{"openapi", "json_schema", "helm", "dockerfile_shell", "project_linter"} {
		got := part(t, b, id)
		if got.State != resultset.PartNotApplicable {
			t.Errorf("part %s state = %s, want not_applicable", id, got.State)
		}
		wantNull(t, id+" score", got.Score)
	}
	if v := area(t, b, "validity"); !v.Exists || !v.FullyMeasured {
		t.Errorf("validity exists %v, fully measured %v", v.Exists, v.FullyMeasured)
	}
}

func TestAnAreaWithEveryPartDroppedIsDroppedAndTheOtherWeightsAreRenormalized(t *testing.T) {
	p := resultsettest.ScoredProject()
	for _, id := range validityChecks {
		p.NotApplicable(id)
	}
	// Security at 0 makes the weighting visible: 40*100 + 25*0 + 15*100 of 80.
	p.Add("security.secrets", "generic-api-key", false)
	b := score(t, p).Benchmark

	v := area(t, b, "validity")
	if v.Exists || v.FullyMeasured {
		t.Errorf("validity exists %v, fully measured %v, want a dropped area", v.Exists, v.FullyMeasured)
	}
	wantNull(t, "validity score", v.Score)
	wantNull(t, "validity contribution", v.Contribution)
	wantScore(t, "score", b.Score, 68.8)
	wantScore(t, "tests contribution", area(t, b, "tests").Contribution, 50)
	wantScore(t, "security contribution", area(t, b, "security").Contribution, 0)
	wantScore(t, "code contribution", area(t, b, "code_correctness").Contribution, 18.8)
}

func TestTheProjectsFaultCountsAsZeroAndKeepsTheScore(t *testing.T) {
	// The lockfile does not match package.json: the install fails, and what
	// needs the install is blocked because of the project, not the Run.
	p := resultsettest.ScoredProject()
	p.Add("package.install", "lockfile-out-of-sync", true)
	for _, id := range []string{"tests.existing", "deps.tree"} {
		p.Status(id, resultset.StatusBlocked, "prerequisite_failed_project")
	}
	p.TestFiles()
	b := score(t, p).Benchmark

	assertProjectFault(t, part(t, b, "pass_rate"), "prerequisite_failed_project")
	assertProjectFault(t, part(t, b, "dependency_tree"), "prerequisite_failed_project")
	wantScore(t, "install", part(t, b, "install").Score, 0)
	wantScore(t, "tests area", area(t, b, "tests").Score, 0)
	wantScore(t, "validity area", area(t, b, "validity").Score, 0)
	if b.Score == nil {
		t.Fatal("the project's fault must not take the score away")
	}
	// Tests 0, Validity 0, Security 100, Code 100: 25 + 15.
	wantScore(t, "score", b.Score, 40)
	if *b.Verdict != resultset.VerdictFail {
		t.Errorf("verdict = %s, want fail", *b.Verdict)
	}
}

func TestARunFailureMakesAPartUnknownAndTheRangeCoversBothEnds(t *testing.T) {
	cases := []struct {
		name  string
		apply func(p *resultsettest.Project)
		why   string
	}{
		{"unsupported", func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusUnsupported, "test_runner_not_implemented")
		}, "unsupported: test_runner_not_implemented"},
		{"timed out", func(p *resultsettest.Project) { p.Status("tests.existing", resultset.StatusTimedOut, "timed_out") }, "timed_out: timed_out"},
		{"budget exhausted", func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusBudgetExhausted, "budget_exhausted")
		}, "budget_exhausted: budget_exhausted"},
		{"tool error", func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusToolError, "no_test_events")
		}, "tool_error: no_test_events"},
		{"infrastructure error", func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusInfrastructureError, "registry_unreachable")
		}, "infrastructure_error: registry_unreachable"},
		{"cancelled", func(p *resultsettest.Project) { p.Status("tests.existing", resultset.StatusCancelled, "") }, "cancelled"},
		{"blocked for a reason of the Run", func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusBlocked, "missing_registry_credentials")
		}, "blocked: missing_registry_credentials"},
		{"partial", func(p *resultsettest.Project) { p.Status("tests.existing", resultset.StatusPartial, "out_of_memory") }, "partial: out_of_memory"},
		{"deselected", func(p *resultsettest.Project) { p.Deselect("tests.existing") }, "deselected"},
		{"deselected by --fast", func(p *resultsettest.Project) { p.DeselectByFast("tests.existing") }, "deselected by --fast"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.apply(p)
			b := score(t, p).Benchmark

			got := part(t, b, "pass_rate")
			if got.State != resultset.PartUnknown {
				t.Fatalf("state = %s, want unknown", got.State)
			}
			if got.Reason == nil || *got.Reason != tc.why {
				t.Errorf("reason = %v, want %q", got.Reason, tc.why)
			}
			wantNull(t, "part score", got.Score)
			wantNull(t, "raw value", got.RawValue)

			tests := area(t, b, "tests")
			if tests.FullyMeasured {
				t.Error("the Tests area is fully measured with an unknown part")
			}
			wantNull(t, "tests score", tests.Score)
			// Unknown at 0: only Validity, Security and Code count. Unknown at
			// 100: the area stays at the minimum of its measured parts.
			wantScore(t, "tests range low", &tests.Range.Low, 0)
			wantScore(t, "tests range high", &tests.Range.High, 100)
			wantScore(t, "range low", &b.Range.Low, 60)
			wantScore(t, "range high", &b.Range.High, 100)

			wantNull(t, "score", b.Score)
			if b.Status != resultset.BenchmarkIncomplete || *b.Verdict != resultset.VerdictIncomplete {
				t.Errorf("status %s, verdict %s, want incomplete both", b.Status, *b.Verdict)
			}
		})
	}
}

func TestTheHighEndOfTheRangeStaysAtTheMinimumOfTheMeasuredParts(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("tests.existing", resultset.StatusUnsupported, "test_runner_not_implemented")
	// Smells at n_eff 5 score 50, so the Tests area cannot exceed 50.
	for _, rule := range []string{"a", "b", "c", "d", "e"} {
		p.Add("tests.smells", "mocha/"+rule, false)
	}
	b := score(t, p).Benchmark
	wantScore(t, "tests range high", &area(t, b, "tests").Range.High, 50)
	wantScore(t, "range high", &b.Range.High, 80) // 40% of 50 plus the other 60
	wantScore(t, "range low", &b.Range.Low, 60)
}

func TestAnUnknownSecurityPartTakesTheSingleScoreAway(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("security.dependencies", resultset.StatusInfrastructureError, "advisory_database_unavailable")
	b := score(t, p).Benchmark
	wantNull(t, "score", b.Score)
	wantScore(t, "range low", &b.Range.Low, 75) // Security's vulnerabilities part at 0
	wantScore(t, "range high", &b.Range.High, 100)
}

func TestADeselectedCheckIsUnknownSoNobodyRaisesAScoreByExcludingChecks(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("security.secrets", "generic-api-key", false)
	// The secret would have scored Security 0; excluding the Check hides it.
	hidden := resultsettest.ScoredProject()
	hidden.Deselect("security.secrets")
	b := score(t, hidden).Benchmark
	if got := part(t, b, "secrets"); got.State != resultset.PartUnknown {
		t.Errorf("a deselected Check gave state %s, want unknown", got.State)
	}
	wantNull(t, "score", b.Score)
	wantScore(t, "range low", &b.Range.Low, 75)
}

func TestTheSingleScoreNeedsEightyPercentOfTheExistingWeightMeasured(t *testing.T) {
	t.Run("one unknown Code correctness part still gives a score from the rest", func(t *testing.T) {
		p := resultsettest.ScoredProject()
		p.Deselect("lint.correctness")
		p.Add("security.dependencies", "GHSA-high", false, advisory("high", "prod")...)
		p.Add("security.dependencies", "GHSA-mod-1", false, advisory("moderate", "prod")...)
		p.Add("security.dependencies", "GHSA-mod-2", false, advisory("moderate", "prod")...)
		b := score(t, p).Benchmark

		code := area(t, b, "code_correctness")
		if code.FullyMeasured {
			t.Error("Code correctness is fully measured with an unknown part")
		}
		wantNull(t, "code contribution", code.Contribution)
		// (40*100 + 20*100 + 25*53.59) / 85, the unmeasured 15 left out.
		wantScore(t, "score", b.Score, 86.3)
		wantScore(t, "tests contribution", area(t, b, "tests").Contribution, 47.1)
		wantScore(t, "range low", &b.Range.Low, 73.4) // 100*.40 + 100*.20 + 53.59*.25 + 0
		wantScore(t, "range high", &b.Range.High, 88.4)
		if b.Status != resultset.BenchmarkComputed || *b.Verdict != resultset.VerdictPass {
			t.Errorf("status %s, verdict %s, want computed and pass", b.Status, *b.Verdict)
		}
	})
}

func TestGatesNeverChangeTheScoreOrTheRange(t *testing.T) {
	// A test that fails and a test that is skipped lower the pass rate the
	// same way. Only the failing one is a Gate.
	skipped := resultsettest.ScoredProject()
	skipped.TestFiles(fileCount("test/a.test.js", 4, 3, 0))
	without := score(t, skipped).Benchmark

	failing := resultsettest.ScoredProject()
	failing.TestFiles(fileCount("test/a.test.js", 4, 3, 0))
	failing.Add("tests.existing", "test-failed", true)
	with := score(t, failing).Benchmark

	if without.Score == nil || with.Score == nil || *without.Score != *with.Score {
		t.Errorf("score %v without the Gate, %v with it", without.Score, with.Score)
	}
	if *without.Range != *with.Range {
		t.Errorf("range %+v without the Gate, %+v with it", *without.Range, *with.Range)
	}
	if *without.Verdict != resultset.VerdictPass || *with.Verdict != resultset.VerdictFail {
		t.Errorf("verdicts %s and %s, want pass and fail", *without.Verdict, *with.Verdict)
	}
	if len(with.GateFindingIDs) != 1 || with.GateFindingIDs[0] != "F-0001" {
		t.Errorf("gate findings = %v, want F-0001", with.GateFindingIDs)
	}
}

func TestAGateWithoutAScoreGivesVerdictFail(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("security.dependencies", resultset.StatusInfrastructureError, "advisory_database_unavailable")
	p.Add("syntax.parse", "SyntaxError", true)
	b := score(t, p).Benchmark
	wantNull(t, "score", b.Score)
	if *b.Verdict != resultset.VerdictFail {
		t.Errorf("verdict = %s, want fail", *b.Verdict)
	}
	if b.Range == nil {
		t.Error("the range is always computed")
	}
}

func TestTheScoreIsTheSameWhateverOrderTheResultsCameIn(t *testing.T) {
	build := func(reverse bool) resultset.Benchmark {
		p := resultsettest.ScoredProject()
		rules := []string{"a", "b", "c"}
		if reverse {
			rules = []string{"c", "b", "a"}
		}
		for _, r := range rules {
			p.Add("lint.correctness", r, false)
		}
		if reverse {
			p.Set.Checks[0], p.Set.Checks[len(p.Set.Checks)-1] = p.Set.Checks[len(p.Set.Checks)-1], p.Set.Checks[0]
		}
		return score(t, p).Benchmark
	}
	a, b := build(false), build(true)
	if *a.Score != *b.Score || a.Fingerprint.Hash != b.Fingerprint.Hash {
		t.Errorf("score %v and %v, fingerprints %s and %s", *a.Score, *b.Score, a.Fingerprint.Hash, b.Fingerprint.Hash)
	}
}

// A package ESLint could not parse has no hits because nobody looked. The three
// Checks that read the ESLint run are then partial with files_not_parsed, and a
// partial Check is unknown, so the part is not scored as a clean 100. The
// existing policy decides what that does to the single score: an unknown part
// of the Tests area takes it away, while the Code area is not one of the areas
// a single score needs, so there the score stays and the area is shown as not
// fully measured, with the range around it.
func TestAPartWhoseCheckIsPartialBecauseFilesDidNotParseIsUnknownAndTheRangeCoversIt(t *testing.T) {
	for _, tc := range []struct {
		check, part, area string
		singleScore       bool
	}{
		{"lint.correctness", "correctness_lint", "code_correctness", true},
		{"deps.engines", "node_compatibility", "code_correctness", true},
		{"tests.smells", "smells", "tests", false},
	} {
		t.Run(tc.check, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			p.Status(tc.check, resultset.StatusPartial, "files_not_parsed")
			b := score(t, p).Benchmark

			got := part(t, b, tc.part)
			if got.State != resultset.PartUnknown {
				t.Fatalf("state = %s, want unknown", got.State)
			}
			if got.Reason == nil || *got.Reason != "partial: files_not_parsed" {
				t.Errorf("reason = %v", got.Reason)
			}
			wantNull(t, "part score", got.Score)
			if area(t, b, tc.area).FullyMeasured {
				t.Errorf("the %s area is fully measured with an unknown part", tc.area)
			}
			if b.Range.Low >= b.Range.High {
				t.Errorf("range = %v to %v, want a real range", b.Range.Low, b.Range.High)
			}
			if tc.singleScore {
				if b.Score == nil {
					t.Error("score is null, but the Code area is not needed for a single score")
				}
				return
			}
			wantNull(t, "score", b.Score)
			if b.Status != resultset.BenchmarkIncomplete || *b.Verdict != resultset.VerdictIncomplete {
				t.Errorf("status %s, verdict %s, want incomplete both", b.Status, *b.Verdict)
			}
		})
	}
}
