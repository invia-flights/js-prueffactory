import assert from "node:assert/strict";
import { test } from "node:test";

import { round } from "./math.ts";
import { formatFloatF } from "./strconv.ts";

// strconv.FormatFloat(x, 'f', -1, 64): the shortest digits that read back as
// x, never in exponent form. Expected values are Go's.
test("formatFloatF writes the shortest digits without an exponent", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [-0, "-0"],
    [2.57, "2.57"],
    [1000000, "1000000"],
    [1e21, "1000000000000000000000"],
    [1.5e22, "15000000000000000000000"],
    [1e-7, "0.0000001"],
    [-1.25e-5, "-0.0000125"],
    [0.1 + 0.2, "0.30000000000000004"],
    [123.456, "123.456"],
  ];
  for (const [x, want] of cases) {
    assert.equal(formatFloatF(x), want, String(x));
  }
});

// math.Round rounds half away from zero; Math.round rounds half up.
test("round rounds half away from zero", () => {
  const cases: [number, number][] = [
    [2.5, 3],
    [-2.5, -3],
    [-2.4, -2],
    [0.49999999999999994, 0],
    [256.67, 257],
  ];
  for (const [x, want] of cases) {
    assert.equal(round(x), want, String(x));
  }
  assert.ok(Object.is(round(-0.4), -0), "keeps the sign of zero");
});
