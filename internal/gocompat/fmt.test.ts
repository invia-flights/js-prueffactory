import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  formatFloatFixed,
  formatFloatV,
  quote,
  quoteBytes,
  quoteRune,
} from "./fmt.ts";

// What the Go standard library computes for the same inputs (see recordedFrom).
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  quote: { In: string; Quote: string }[];
  floats: { In: number; V: string; F0: string; F1: string; F2: string }[];
  fixed: { In: number; Neg: boolean; F0: string; F1: string; F2: string }[];
};

describe("%q", () => {
  for (const c of oracle.quote) {
    test(JSON.stringify(c.In), () => {
      assert.equal(quote(c.In), c.Quote);
    });
  }

  // From the Docker driver's former helper (ticket 11): texts its messages quote.
  test("paths, arguments and astral characters", () => {
    assert.equal(quote("/Users/me/project"), '"/Users/me/project"');
    assert.equal(quote("A=B --privileged"), '"A=B --privileged"');
    assert.equal(quote("\u{E0001}"), '"\\U000e0001"');
  });

  test("a lone surrogate prints as the U+FFFD it is written as", () => {
    assert.equal(quote("\uD800"), '"\uFFFD"');
  });
});

describe("%v of a float64", () => {
  for (const c of oracle.floats) {
    test(c.V, () => {
      assert.equal(formatFloatV(c.In), c.V);
    });
  }
  test("negative zero", () => {
    assert.equal(formatFloatV(-0), "-0");
  });
});

describe("%.Nf of a float64", () => {
  for (const c of [...oracle.floats, ...oracle.fixed]) {
    const x = "Neg" in c && c.Neg && c.In === 0 ? -0 : c.In;
    test(`${c.F1} (${String(c.In)})`, () => {
      assert.equal(formatFloatFixed(x, 0), c.F0, "%.0f");
      assert.equal(formatFloatFixed(x, 1), c.F1, "%.1f");
      assert.equal(formatFloatFixed(x, 2), c.F2, "%.2f");
    });
  }

  test("a tie rounds to even, where toFixed rounds up", () => {
    assert.equal((0.25).toFixed(1), "0.3");
    assert.equal(formatFloatFixed(0.25, 1), "0.2");
  });
});

describe("strconv.QuoteRune and Quote of bytes", () => {
  test("quoteRune", () => {
    assert.equal(quoteRune(0x27), "'\\''");
    assert.equal(quoteRune(0xa0), "'\\u00a0'");
    assert.equal(quoteRune(0x0b), "'\\v'");
    assert.equal(quoteRune(0x1f600), "'\u{1f600}'");
  });
  test("quoteBytes writes invalid bytes as \\x escapes", () => {
    assert.equal(
      quoteBytes(Buffer.from([0x5c, 0xff, 0x22, 0x09])),
      '"\\\\\\xff\\"\\t"',
    );
  });
});
