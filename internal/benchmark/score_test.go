package benchmark_test

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// score applies the Benchmark to a finalized set and checks that the set is
// still consistent, before any other assertion.
func score(t *testing.T, p *resultsettest.Project) *resultset.Set {
	t.Helper()
	s := p.Done()
	benchmark.Apply(s)
	if problems := s.Validate(); len(problems) > 0 {
		t.Fatalf("the scored set is not consistent: %v", problems)
	}
	return s
}

func area(t *testing.T, b resultset.Benchmark, id string) resultset.BenchmarkArea {
	t.Helper()
	for _, a := range b.Areas {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("no area %q in %v", id, b.Areas)
	return resultset.BenchmarkArea{}
}

func part(t *testing.T, b resultset.Benchmark, id string) resultset.BenchmarkPart {
	t.Helper()
	for _, a := range b.Areas {
		for _, p := range a.Parts {
			if p.ID == id {
				return p
			}
		}
	}
	t.Fatalf("no part %q", id)
	return resultset.BenchmarkPart{}
}

func wantScore(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s is null, want %v", name, want)
		return
	}
	if math.Abs(*got-want) > 0.05 {
		t.Errorf("%s = %v, want %v", name, *got, want)
	}
}

func wantNull(t *testing.T, name string, got *float64) {
	t.Helper()
	if got != nil {
		t.Errorf("%s = %v, want null", name, *got)
	}
}

func TestACleanProjectScoresOneHundredAndPasses(t *testing.T) {
	s := score(t, resultsettest.ScoredProject())
	b := s.Benchmark

	if b.Status != resultset.BenchmarkComputed {
		t.Errorf("status = %q, want computed", b.Status)
	}
	if b.ProfileID == nil || *b.ProfileID != "benchmark-v1-uncalibrated" {
		t.Errorf("profile = %v, want benchmark-v1-uncalibrated", b.ProfileID)
	}
	if s.Profiles.BenchmarkProfile == nil || *s.Profiles.BenchmarkProfile != "benchmark-v1-uncalibrated" {
		t.Errorf("profiles.benchmark_profile = %v", s.Profiles.BenchmarkProfile)
	}
	wantScore(t, "score", b.Score, 100)
	if b.Range == nil || b.Range.Low != 100 || b.Range.High != 100 {
		t.Errorf("range = %+v, want 100 to 100", b.Range)
	}
	if b.Verdict == nil || *b.Verdict != resultset.VerdictPass {
		t.Errorf("verdict = %v, want pass", b.Verdict)
	}
	if len(b.GateFindingIDs) != 0 {
		t.Errorf("gate findings = %v, want none", b.GateFindingIDs)
	}
}

func TestComputeReadsTheSetAndChangesNothingInIt(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("lint.correctness", "no-undef", false)
	p.Add("syntax.parse", "SyntaxError", true)
	s := p.Done()
	before, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	first := benchmark.Compute(s)
	after, _ := json.Marshal(s)
	if string(before) != string(after) {
		t.Error("Compute changed the result set")
	}
	again, _ := json.Marshal(benchmark.Compute(s))
	once, _ := json.Marshal(first)
	if string(again) != string(once) {
		t.Error("Compute gives different sections for the same set")
	}
	if s.Benchmark.Status != resultset.BenchmarkNotRequested {
		t.Errorf("status = %q, only Apply stores the section", s.Benchmark.Status)
	}
}

func TestTheFourAreasHaveTheSpecWeightsAndTheirContributionsAddUpToTheScore(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	want := []struct {
		id     string
		weight int
	}{{"tests", 40}, {"validity", 20}, {"security", 25}, {"code_correctness", 15}}
	if len(b.Areas) != len(want) {
		t.Fatalf("areas = %d, want %d", len(b.Areas), len(want))
	}
	for i, w := range want {
		a := b.Areas[i]
		if a.ID != w.id || a.Weight != w.weight {
			t.Errorf("area %d = %s weight %d, want %s weight %d", i, a.ID, a.Weight, w.id, w.weight)
		}
		if !a.Exists || !a.FullyMeasured {
			t.Errorf("area %s: exists %v, fully measured %v", a.ID, a.Exists, a.FullyMeasured)
		}
		wantScore(t, a.ID+" score", a.Score, 100)
		wantScore(t, a.ID+" contribution", a.Contribution, float64(w.weight))
	}
}

func TestEveryPartShowsItsConstantsAndSourceChecks(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	x50 := map[string]float64{
		"smells": 5, "syntax": 1, "structured_files": 1, "openapi": 2, "json_schema": 2, "helm": 1,
		"dependency_tree": 3, "dockerfile_shell": 3, "vulnerabilities": 10, "lockfile_integrity": 5,
		"correctness_lint": 10, "project_linter": 5, "node_compatibility": 3, "suppressions": 20,
	}
	notCountBased := []string{"pass_rate", "manifest", "install", "secrets"}
	for id, want := range x50 {
		p := part(t, b, id)
		if p.X50 == nil || *p.X50 != want {
			t.Errorf("part %s x50 = %v, want %v", id, p.X50, want)
		}
		if len(p.SourceChecks) == 0 {
			t.Errorf("part %s names no source Check", id)
		}
	}
	for _, id := range notCountBased {
		if p := part(t, b, id); p.X50 != nil {
			t.Errorf("part %s is not count-based but has x50 %v", id, *p.X50)
		}
	}
	if p := part(t, b, "dockerfile_shell"); len(p.SourceChecks) != 2 {
		t.Errorf("dockerfile_shell sources = %v, want repository.dockerfile and repository.shell", p.SourceChecks)
	}
}
