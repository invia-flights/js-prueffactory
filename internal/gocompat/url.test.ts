import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hostname, parse, URLError } from "./url.ts";

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
    let got: Row;
    try {
      const u = parse(want.in);
      got = {
        in: want.in,
        ok: true,
        err: "",
        scheme: u.scheme,
        host: u.host,
        hostname: hostname(u),
      };
    } catch (err) {
      assert.ok(err instanceof URLError, String(err));
      got = {
        in: want.in,
        ok: false,
        err: err.message,
        scheme: "",
        host: "",
        hostname: "",
      };
    }
    assert.deepEqual(got, want);
  }
});
