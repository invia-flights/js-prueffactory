import { round } from "../gocompat/math.ts";
import { compareBytes } from "../gocompat/strings.ts";

// Go's math.Exp2 and math.Log2 and V8's Math.pow and Math.log2 differ in the
// last bit for about one input in ten (and Go itself differs between arm64
// and amd64). The Report shows only round1 and round2 of them; over the
// recorded grid in testdata/go-oracle.json the rounded values agree with both
// Go builds.

/**
 * partScore is the score of a count-based part: S = 100 * 2^(-x / x50), where
 * x50 is the amount that halves the score.
 */
export function partScore(x: number, x50: number): number {
  return 100 * Math.pow(2, -x / x50);
}

/**
 * nEff damps repeated hits of one rule: n_eff = sum over rules of
 * (1 + log2 count). Two hits of a rule weigh 2, four weigh 3, and 200 weigh
 * about 8.6, so 200 copies of one warning cost less than ten different
 * problems.
 *
 * Go summed over a map in random order; the sum here runs in byte order of
 * the rule IDs, so it does not depend on the order the Findings came in.
 */
export function nEff(countPerRule: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const rule of [...countPerRule.keys()].sort(compareBytes)) {
    const count = countPerRule.get(rule) ?? 0;
    if (count > 0) {
      n += 1 + Math.log2(count);
    }
  }
  return n;
}

/** round1 rounds a score to one decimal, which is how the Report shows it. */
export function round1(v: number): number {
  return round(v * 10) / 10;
}

/** round2 rounds a raw value or damped count to two decimals. */
export function round2(v: number): number {
  return round(v * 100) / 100;
}
