package benchmark

import (
	"math"
	"testing"
)

func near(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestACountBasedPartHalvesAtItsX50(t *testing.T) {
	near(t, "S(0)", partScore(0, 5), 100)
	near(t, "S(x50)", partScore(5, 5), 50)
	near(t, "S(2*x50)", partScore(10, 5), 25)
	near(t, "S(x50/2)", partScore(2.5, 5), 100/math.Sqrt2)
}

// The spec's worked example: V = 9 with x50 = 10 gives a part score of 53.6.
// The part-level test with real advisories is in parts_test.go.
func TestAVulnerabilityValueOfNineScoresFiftyThreePointSix(t *testing.T) {
	if got := round1(partScore(9, 10)); got != 53.6 {
		t.Errorf("part score = %v, want 53.6", got)
	}
}

func TestRepeatedHitsOfOneRuleAreDampedLogarithmically(t *testing.T) {
	tests := []struct {
		name   string
		counts map[string]int
		want   float64
	}{
		{"no hits", nil, 0},
		{"one hit of one rule", map[string]int{"a": 1}, 1},
		{"two hits of one rule", map[string]int{"a": 2}, 2},
		{"four hits of one rule", map[string]int{"a": 4}, 3},
		{"200 copies of one warning stay far below ten different problems", map[string]int{"a": 200}, 1 + math.Log2(200)},
		{"ten different rules, once each", map[string]int{"a": 1, "b": 1, "c": 1, "d": 1, "e": 1, "f": 1, "g": 1, "h": 1, "i": 1, "j": 1}, 10},
		{"rules add up", map[string]int{"a": 2, "b": 4}, 2 + 3},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			near(t, "n_eff", nEff(tc.counts), tc.want)
		})
	}
	if nEff(map[string]int{"a": 200}) >= nEff(map[string]int{"a": 1, "b": 1, "c": 1, "d": 1, "e": 1, "f": 1, "g": 1, "h": 1, "i": 1, "j": 1}) {
		t.Error("200 copies of one rule weigh as much as ten different problems")
	}
}
