// url.parse against what Go's url.Parse said for the inputs of
// go-oracle-url.json (ticket 20's lockfile `resolved` values and hosts; the
// JSON Schema formats of ticket 5 and 18 use the same module).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hostname, parse } from "./url.ts";

interface Row {
  in: string;
  ok: boolean;
  err: string;
  scheme: string;
  host: string;
  hostname: string;
}

const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle-url.json", import.meta.url), "utf8"),
) as { parse: Row[] };

test("parse accepts and rejects what Go's url.Parse does, with Go's text, scheme and host", () => {
  assert.ok(oracle.parse.length > 90);
  for (const want of oracle.parse) {
    const r = parse(want.in);
    const got: Row =
      "url" in r
        ? {
            in: want.in,
            ok: true,
            err: "",
            scheme: r.url.scheme,
            host: r.url.host,
            hostname: hostname(r.url),
          }
        : {
            in: want.in,
            ok: false,
            err: r.error,
            scheme: "",
            host: "",
            hostname: "",
          };
    assert.deepEqual(got, want);
  }
});
