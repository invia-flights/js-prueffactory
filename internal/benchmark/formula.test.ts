import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { formatFloatV } from "../gocompat/fmt.ts";
import { nEff, partScore, round1, round2 } from "./formula.ts";

function near(name: string, got: number, want: number): void {
  assert.ok(
    Math.abs(got - want) <= 1e-9,
    `${name} = ${String(got)}, want ${String(want)}`,
  );
}

const counts = (o: Record<string, number>) => new Map(Object.entries(o));

// Go: TestACountBasedPartHalvesAtItsX50.
test("a count-based part halves at its x50", () => {
  near("S(0)", partScore(0, 5), 100);
  near("S(x50)", partScore(5, 5), 50);
  near("S(2*x50)", partScore(10, 5), 25);
  near("S(x50/2)", partScore(2.5, 5), 100 / Math.SQRT2);
});

// Go: TestAVulnerabilityValueOfNineScoresFiftyThreePointSix. The spec's
// worked example: V = 9 with x50 = 10 gives a part score of 53.6.
test("a vulnerability value of nine scores 53.6", () => {
  assert.equal(round1(partScore(9, 10)), 53.6);
});

// Go: TestRepeatedHitsOfOneRuleAreDampedLogarithmically.
describe("repeated hits of one rule are damped logarithmically", () => {
  const ten = new Map(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((rule) => [rule, 1]),
  );
  const cases: [string, Map<string, number>, number][] = [
    ["no hits", new Map<string, number>(), 0],
    ["one hit of one rule", counts({ a: 1 }), 1],
    ["two hits of one rule", counts({ a: 2 }), 2],
    ["four hits of one rule", counts({ a: 4 }), 3],
    [
      "200 copies of one warning stay far below ten different problems",
      counts({ a: 200 }),
      8.643856189774725, // 1 + log2(200)
    ],
    ["ten different rules, once each", ten, 10],
    ["rules add up", counts({ a: 2, b: 4 }), 2 + 3],
  ];
  for (const [name, c, want] of cases) {
    test(name, () => {
      near("n_eff", nEff(c), want);
    });
  }
  test("200 copies of one rule weigh less than ten different problems", () => {
    assert.ok(nEff(counts({ a: 200 })) < nEff(ten));
  });
});

test("n_eff does not depend on the order the rules came in", () => {
  // Three rules whose terms do not add up exactly: Go summed them in random
  // map order; the port sums in byte order of the rule IDs.
  const forward = new Map([
    ["a", 3],
    ["b", 5],
    ["c", 7],
  ]);
  const backward = new Map([...forward].reverse());
  assert.equal(nEff(forward), nEff(backward));
});

// go-oracle.json holds what the Go build's round1(partScore) and
// round2(1 + log2) give over a grid of inputs (generator:
// testdata/go-oracle.go.txt). Go's arm64 and amd64 builds differ from each
// other and from V8 in the last bit of Exp2 and Log2 for about one input in
// ten; the rounded values the Report shows agree. Each grid is compared as a
// SHA-256 of its values, one per line in Go's %v.
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  recordedFrom: string;
  grids: Record<string, { count: number; sha256: string }>;
};

function gridHash(values: readonly number[]): string {
  return createHash("sha256")
    .update(values.map(formatFloatV).join("\n"))
    .digest("hex");
}

const x50s = [1, 2, 3, 5, 10, 20];

function grids(): Record<string, number[]> {
  const exp: number[] = [];
  for (const x50 of x50s) {
    for (let i = 0; i <= 4000; i++) {
      exp.push(round1(partScore(i / 8, x50)));
    }
  }
  const log: number[] = [];
  for (let c = 1; c <= 20000; c++) {
    log.push(round2(nEff(new Map([["a", c]]))));
  }
  const damped: number[] = [];
  for (let a = 1; a <= 200; a++) {
    for (let b = 0; b <= 200; b++) {
      const m = new Map([["a", a]]);
      if (b > 0) {
        m.set("b", b);
      }
      const n = nEff(m);
      for (const x50 of x50s) {
        damped.push(round1(partScore(n, x50)));
      }
    }
  }
  return { partScore: exp, nEff: log, dampedPartScore: damped };
}

describe("the rounded formula values equal the Go build's over a grid", () => {
  const got = grids();
  for (const [name, want] of Object.entries(oracle.grids)) {
    test(name, () => {
      const values = got[name];
      assert.ok(values, `no grid ${name}`);
      assert.equal(values.length, want.count);
      assert.equal(gridHash(values), want.sha256);
    });
  }
});
