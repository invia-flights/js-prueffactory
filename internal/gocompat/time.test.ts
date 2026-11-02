import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseInt64 } from "./strconv.ts";
import {
  durationString,
  formatCompactUTC,
  hours,
  parseDuration,
  parseRFC3339,
  second,
  sub,
  wrapInt64,
} from "./time.ts";

// What the Go standard library computes for the same inputs (see recordedFrom).
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle-cli.json", import.meta.url), "utf8"),
) as {
  parseDuration: { In: string; Nanos: string; Err: string }[];
  durationString: { Nanos: string; String: string }[];
  secondsWrap: { Secs: string; Nanos: string }[];
  parseInt: { In: string; Value: string; Err: string }[];
};

describe("time.ParseDuration", () => {
  for (const c of oracle.parseDuration) {
    test(`${JSON.stringify(c.In)} gives ${c.Err || c.Nanos}`, () => {
      if (c.Err !== "") {
        assert.throws(() => parseDuration(c.In), { message: c.Err });
      } else {
        assert.equal(parseDuration(c.In), BigInt(c.Nanos));
      }
    });
  }
});

describe("Duration.String", () => {
  for (const c of oracle.durationString) {
    test(`${c.Nanos}ns prints as ${c.String}`, () => {
      assert.equal(durationString(BigInt(c.Nanos)), c.String);
    });
  }
});

describe("time.Duration(secs) * time.Second wraps like int64", () => {
  for (const c of oracle.secondsWrap) {
    test(`${c.Secs} seconds`, () => {
      assert.equal(wrapInt64(BigInt(c.Secs) * second), BigInt(c.Nanos));
    });
  }
});

describe("strconv.ParseInt(s, 10, 64)", () => {
  for (const c of oracle.parseInt) {
    test(`${JSON.stringify(c.In)} gives ${c.Err || c.Value}`, () => {
      if (c.Err !== "") {
        assert.throws(() => parseInt64(c.In), { message: c.Err });
      } else {
        assert.equal(parseInt64(c.In), BigInt(c.Value));
      }
    });
  }
});

test("the layout 20060102T150405Z is in UTC and leaves out the fraction", () => {
  const t = new Date(Date.UTC(2026, 9, 25, 10, 15, 0, 999));
  assert.equal(formatCompactUTC(t), "20261025T101500Z");
});

test("parseRFC3339 and hours of the time between give Go's values", () => {
  const oracle = JSON.parse(
    readFileSync(
      new URL("testdata/go-oracle-rfc3339.json", import.meta.url),
      "utf8",
    ),
  ) as {
    parse: {
      in: string;
      ok: boolean;
      unix_nano: string;
      hours_since_previous: string;
    }[];
  };
  let prev: bigint | undefined;
  for (const want of oracle.parse) {
    const got = parseRFC3339(want.in);
    assert.equal(got !== undefined, want.ok, want.in);
    if (got === undefined) continue;
    const [secs = "", nanos = ""] = want.unix_nano.split(".");
    assert.equal(got, BigInt(secs) * second + BigInt(nanos), want.in);
    if (prev !== undefined) {
      assert.equal(
        hours(sub(got, prev)),
        Number(want.hours_since_previous),
        want.in,
      );
    }
    prev = got;
  }
});
