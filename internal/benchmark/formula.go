package benchmark

import "math"

// partScore is the score of a count-based part: S = 100 * 2^(-x / x50), where
// x50 is the amount that halves the score.
func partScore(x, x50 float64) float64 {
	return 100 * math.Exp2(-x/x50)
}

// nEff damps repeated hits of one rule: n_eff = sum over rules of
// (1 + log2 count). Two hits of a rule weigh 2, four weigh 3, and 200 weigh
// about 8.6, so 200 copies of one warning cost less than ten different
// problems.
func nEff(countPerRule map[string]int) float64 {
	var n float64
	for _, count := range countPerRule {
		if count > 0 {
			n += 1 + math.Log2(float64(count))
		}
	}
	return n
}

// round1 rounds a score to one decimal, which is how the Report shows it.
func round1(v float64) float64 { return math.Round(v*10) / 10 }

// round2 rounds a raw value or damped count to two decimals.
func round2(v float64) float64 { return math.Round(v*100) / 100 }
