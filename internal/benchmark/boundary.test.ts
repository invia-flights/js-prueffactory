import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import { StatusTimedOut } from "../resultset/types.ts";
import {
  areaCode,
  areaSecurity,
  areaTests,
  areaValidity,
  v0,
} from "./profile.ts";
import { computeWith } from "./score.ts";

// Go: TestTheSingleScoreRuleAtTheEightyPercentBoundary. With the weights of
// milestone 1 the required areas always hold at least 85%, so the 80%
// boundary can only be reached with other weights. The rule is the same code,
// tried here with weights that put the fully measured areas exactly on, and
// just under, 80% of the existing weight.
describe("the single score rule at the 80 percent boundary", () => {
  const cases: [string, [number, number, number, number], boolean][] = [
    ["exactly 80 percent is enough", [40, 20, 20, 20], true],
    ["79 percent is not", [40, 19, 20, 21], false],
    ["81 percent is enough", [40, 20, 21, 19], true],
  ];
  for (const [name, [tests, validity, security, code], wantSingle] of cases) {
    test(name, () => {
      const p = scoredProject();
      p.status("lint.correctness", StatusTimedOut, "timed_out");
      const s = p.done();
      const b = computeWith(s, {
        ...v0,
        weights: {
          [areaTests]: tests,
          [areaValidity]: validity,
          [areaSecurity]: security,
          [areaCode]: code,
        },
      });
      assert.equal(b.score !== null, wantSingle, `score ${String(b.score)}`);
      assert.notEqual(b.range, null, "the range is always computed");
    });
  }
});

// Go: TestAnAreaOfTheProfilesRequiredListBlocksTheSingleScoreWhenNotFullyMeasured.
test("an area of the profile's required list blocks the single score when not fully measured", () => {
  const p = scoredProject();
  p.status("lint.correctness", StatusTimedOut, "timed_out");
  const b = computeWith(p.done(), { ...v0, required: [areaCode] });
  assert.equal(b.score, null);
});
