package benchmark

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// With the weights of milestone 1 the required areas always hold at least 85%,
// so the 80% boundary can only be reached with other weights. The rule is the
// same code, tried here with weights that put the fully measured areas exactly
// on, and just under, 80% of the existing weight.
func TestTheSingleScoreRuleAtTheEightyPercentBoundary(t *testing.T) {
	tests := []struct {
		name       string
		weights    map[string]int
		wantSingle bool
	}{
		{"exactly 80 percent is enough", map[string]int{areaTests: 40, areaValidity: 20, areaSecurity: 20, areaCode: 20}, true},
		{"79 percent is not", map[string]int{areaTests: 40, areaValidity: 19, areaSecurity: 20, areaCode: 21}, false},
		{"81 percent is enough", map[string]int{areaTests: 40, areaValidity: 20, areaSecurity: 21, areaCode: 19}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			p.Status("lint.correctness", resultset.StatusTimedOut, "timed_out")
			s := p.Done()

			prof := v0
			prof.weights = tc.weights
			b := compute(s, prof)
			if got := b.Score != nil; got != tc.wantSingle {
				t.Errorf("single score = %v, want %v (score %v)", got, tc.wantSingle, b.Score)
			}
			if b.Range == nil {
				t.Error("the range is always computed")
			}
		})
	}
}

func TestAnAreaOfTheProfilesRequiredListBlocksTheSingleScoreWhenNotFullyMeasured(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("lint.correctness", resultset.StatusTimedOut, "timed_out")
	s := p.Done()
	prof := v0
	prof.required = []string{areaCode}
	if b := compute(s, prof); b.Score != nil {
		t.Errorf("score %v although a required area is not fully measured", *b.Score)
	}
}
