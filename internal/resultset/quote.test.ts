import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { goOracle } from "./helpers.testutil.ts";
import { longestBacktickRun, quote, withoutControls } from "./quote.ts";

// Go has no test of its own for quote.go; the table is what the Go build
// computes for awkward text.
describe("quote, withoutControls and longestBacktickRun equal the Go build's", () => {
  for (const c of goOracle.texts) {
    test(JSON.stringify(c.In), () => {
      assert.equal(quote(c.In), c.Quote);
      assert.equal(withoutControls(c.In), c.WithoutControls);
      assert.equal(longestBacktickRun(c.In), c.Backticks);
    });
  }
});
