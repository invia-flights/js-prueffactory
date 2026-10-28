package resultset_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

func scoredSet(mutate func(p *resultsettest.Project)) *resultset.Set {
	p := resultsettest.ScoredProject()
	if mutate != nil {
		mutate(p)
	}
	s := p.Done()
	benchmark.Apply(s)
	return s
}

func TestAScoredSetIsValid(t *testing.T) {
	for name, mutate := range map[string]func(p *resultsettest.Project){
		"clean": nil,
		"with a Gate": func(p *resultsettest.Project) {
			p.Add("syntax.parse", "SyntaxError", true)
		},
		"incomplete": func(p *resultsettest.Project) {
			p.Status("tests.existing", resultset.StatusUnsupported, "test_runner_not_implemented")
		},
	} {
		t.Run(name, func(t *testing.T) {
			if problems := scoredSet(mutate).Validate(); len(problems) != 0 {
				t.Fatalf("a scored set must be valid: %v", problems)
			}
		})
	}
}

func TestTheValidatorCatchesAScoreThatDisagreesWithItsVerdict(t *testing.T) {
	str := func(s string) *string { return &s }
	num := func(v float64) *float64 { return &v }
	// fired starts from a Report in which a Gate fired, clean from one without.
	const fired, clean = true, false
	mutations := map[string]struct {
		baseline bool
		mutate   func(s *resultset.Set)
		want     string
	}{
		"pass although a Gate fired": {fired, func(s *resultset.Set) { s.Benchmark.Verdict = str("pass") }, "disagrees with"},
		"fail without a Gate":        {clean, func(s *resultset.Set) { s.Benchmark.Verdict = str("fail") }, "disagrees with"},
		"incomplete with a score":    {clean, func(s *resultset.Set) { s.Benchmark.Verdict = str("incomplete") }, "incomplete verdict"},
		"pass without a score": {clean, func(s *resultset.Set) {
			s.Benchmark.Score, s.Benchmark.Status = nil, resultset.BenchmarkIncomplete
		}, "pass without a score"},
		"computed without a score": {clean, func(s *resultset.Set) {
			s.Benchmark.Score, s.Benchmark.Verdict = nil, str("incomplete")
		}, "computed but has no score"},
		"incomplete status with a score": {clean, func(s *resultset.Set) { s.Benchmark.Status = resultset.BenchmarkIncomplete }, "incomplete but has a score"},
		"score over 100":                 {clean, func(s *resultset.Set) { s.Benchmark.Score = num(101) }, "outside 0 to 100"},
		"range upside down": {clean, func(s *resultset.Set) {
			s.Benchmark.Range = &resultset.Range{Low: 80, High: 20}
		}, "range"},
		"no range": {clean, func(s *resultset.Set) { s.Benchmark.Range = nil }, "range"},
		"profile differs from profiles.benchmark_profile": {clean, func(s *resultset.Set) {
			s.Profiles.BenchmarkProfile = str("other")
		}, "profile"},
		"gate list misses a Gate": {fired, func(s *resultset.Set) { s.Benchmark.GateFindingIDs = nil }, "Gate"},
		"gate list holds a Finding that is no Gate": {fired, func(s *resultset.Set) {
			s.Benchmark.GateFindingIDs = append(s.Benchmark.GateFindingIDs, "F-0099")
		}, "Gate"},
		"no areas":       {clean, func(s *resultset.Set) { s.Benchmark.Areas = nil }, "areas"},
		"no fingerprint": {clean, func(s *resultset.Set) { s.Benchmark.Fingerprint = nil }, "fingerprint"},
		"contributions do not add up to the score": {clean, func(s *resultset.Set) {
			s.Benchmark.Areas[0].Contribution = num(1)
		}, "contribution"},
		"benchmark section in a test mode Report": {clean, func(s *resultset.Set) { s.Run.Command = "test" }, "test mode"},
	}
	for name, m := range mutations {
		t.Run(name, func(t *testing.T) {
			var s *resultset.Set
			if m.baseline == fired {
				s = scoredSet(func(p *resultsettest.Project) { p.Add("syntax.parse", "SyntaxError", true) })
			} else {
				s = scoredSet(nil)
			}
			if problems := s.Validate(); len(problems) != 0 {
				t.Fatalf("the baseline is not valid: %v", problems)
			}
			m.mutate(s)
			problems := s.Validate()
			if len(problems) == 0 {
				t.Fatal("the validator accepted the broken set")
			}
			if joined := strings.Join(problems, "\n"); !strings.Contains(joined, m.want) {
				t.Errorf("problems %q lack %q", joined, m.want)
			}
		})
	}
}

func TestABenchmarkModeReportMustCarryABenchmarkSection(t *testing.T) {
	s := resultsettest.ScoredProject().Done()
	s.Run.Command = "benchmark"
	problems := strings.Join(s.Validate(), "\n")
	if !strings.Contains(problems, "benchmark command") {
		t.Errorf("problems %q do not mention the missing benchmark section", problems)
	}
}

func TestATestModeReportKeepsItsSectionNotRequested(t *testing.T) {
	s := resultsettest.Minimal()
	if s.Run.Command != "test" || s.Benchmark.Status != resultset.BenchmarkNotRequested {
		t.Fatalf("command %q, status %q", s.Run.Command, s.Benchmark.Status)
	}
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("a test mode Report is valid: %v", problems)
	}
	s.Benchmark.Areas = scoredSet(nil).Benchmark.Areas
	if problems := strings.Join(s.Validate(), "\n"); !strings.Contains(problems, "not_requested") {
		t.Errorf("a test mode Report with benchmark areas was accepted: %q", problems)
	}
}
