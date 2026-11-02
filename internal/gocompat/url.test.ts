import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { atoi, parseFloat } from "./strconv.ts";
import * as url from "./url.ts";

// Recorded from Go 1.27.3 by testdata/go-oracle-url.go.txt. Strings are byte
// strings: one character per byte, as url.ts holds them.
interface URLCase {
  in: string;
  err: boolean;
  scheme: string;
  opaque: string;
  user: string;
  hasUser: boolean;
  host: string;
  path: string;
  rawPath: string;
  rawQuery: string;
  fragment: string;
  rawFragment: string;
  hostname: string;
  string: string;
  clean: string;
}

const oracle = JSON.parse(
  readFileSync(
    new globalThis.URL("testdata/go-oracle-url.json", import.meta.url),
    "utf8",
  ),
) as {
  url: URLCase[];
  atoi: { in: string; err: boolean; out: string }[];
  parseFloat: { in: string; err: boolean; out: string }[];
};

function userString(u: url.URL): string {
  if (u.user === null) return "";
  return u.toString().length > 0 ? reparseUser(u) : "";
}

// reparseUser shows the userinfo the way Userinfo.String does, through a URL
// that holds nothing else.
function reparseUser(u: url.URL): string {
  const only = new url.URL();
  only.user = u.user;
  only.host = "h";
  return only.toString().slice(2, -2);
}

for (const c of oracle.url) {
  test(`Go parity: url.Parse(${JSON.stringify(c.in)})`, () => {
    let u: url.URL;
    try {
      u = url.parse(c.in);
    } catch {
      assert.ok(c.err, "TypeScript refused what Go accepts");
      return;
    }
    assert.ok(!c.err, `Go refuses it, TypeScript gave ${u.toString()}`);
    assert.deepEqual(
      {
        scheme: u.scheme,
        opaque: u.opaque,
        hasUser: u.user !== null,
        user: userString(u),
        host: u.host,
        path: u.path,
        rawPath: u.rawPath,
        rawQuery: u.rawQuery,
        fragment: u.fragment,
        rawFragment: u.rawFragment,
        hostname: u.hostname(),
        string: u.toString(),
      },
      {
        scheme: c.scheme,
        opaque: c.opaque,
        hasUser: c.hasUser,
        user: c.user,
        host: c.host,
        path: c.path,
        rawPath: c.rawPath,
        rawQuery: c.rawQuery,
        fragment: c.fragment,
        rawFragment: c.rawFragment,
        hostname: c.hostname,
        string: c.string,
      },
    );
    const clean = new url.URL();
    clean.scheme = u.scheme;
    clean.host = u.host;
    clean.path = u.path;
    clean.fragment = u.fragment;
    assert.equal(clean.toString(), c.clean);
  });
}

test("Go parity: strconv.Atoi", () => {
  for (const c of oracle.atoi) {
    const got = atoi(c.in);
    assert.equal(got === undefined, c.err, c.in);
    if (got !== undefined) assert.equal(String(got), c.out, c.in);
  }
});

// formatG is strconv.FormatFloat(x, 'g', -1, 64) for the values the oracle
// holds.
function formatG(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "+Inf";
  if (x === -Infinity) return "-Inf";
  if (Object.is(x, -0)) return "-0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (x !== 0 && (exp < -4 || exp >= 6)) {
    return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(x);
}

test("Go parity: strconv.ParseFloat", () => {
  for (const c of oracle.parseFloat) {
    const got = parseFloat(c.in);
    assert.equal(got === undefined, c.err, JSON.stringify(c.in));
    if (got !== undefined) assert.equal(formatG(got), c.out, c.in);
  }
});

test("url.Parse is linear on long hostile input", () => {
  const long = "https://" + "a".repeat(1 << 20) + "/" + "%41".repeat(1 << 18);
  const start = performance.now();
  url.parse(long);
  try {
    url.parse("https://[" + "1:".repeat(1 << 18) + "]/");
  } catch {
    // refused, as Go refuses it
  }
  assert.ok(performance.now() - start < 2000);
});
