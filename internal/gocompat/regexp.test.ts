// compileError on long hostile expressions: a project's coverage regexp may
// be as long as a project file, and the port must judge it in about linear
// time. The expected texts were recorded from Go 1.27.3's regexp.Compile
// (first 70 bytes); the verdicts and texts of short expressions are checked
// against Go in internal/jsonschema (format regex).
import assert from "node:assert/strict";
import { test } from "node:test";

import { compileError } from "./regexp.ts";

function timed(expr: string): string {
  const start = performance.now();
  const err = compileError(expr);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `took ${String(Math.round(ms))} ms`);
  return err === undefined
    ? "<nil>"
    : Buffer.from(err).subarray(0, 70).toString();
}

test("many [: in one class stay fast", () => {
  assert.equal(
    timed("[" + "[:".repeat(200_000)),
    "error parsing regexp: missing closing ]: `[[:[:[:[:[:[:[:[:[:[:[:[:[:[",
  );
  assert.equal(
    timed("[" + "[:".repeat(200_000) + "]"),
    "error parsing regexp: invalid character class range: `[:[:[:[:[:[:[:[:",
  );
});

test("deeply nested groups stay fast", () => {
  assert.equal(
    timed("(?:".repeat(100_000) + "a" + ")".repeat(100_000)),
    "<nil>",
  );
  assert.equal(
    timed("(".repeat(100_000) + "a" + ")".repeat(100_000)),
    "error parsing regexp: expression nests too deeply: `((((((((((((((((((",
  );
});

test("long runs of names, captures and alternatives stay fast", () => {
  assert.equal(timed("(?P<n>a)".repeat(50_000)), "<nil>");
  assert.equal(
    timed("(?P<" + "(?P<".repeat(100_000)),
    "error parsing regexp: invalid named capture: `(?P<(?P<(?P<(?P<(?P<(?P<",
  );
  assert.equal(
    timed("\\p{" + "x".repeat(200_000)),
    "error parsing regexp: invalid character class range: `\\p{xxxxxxxxxxxxx",
  );
  assert.equal(timed("a|".repeat(200_000) + "b"), "<nil>");
});

test("the size limit is not ported: Go finds these too large, the port accepts them", () => {
  // Go: "error parsing regexp: expression too large" for both.
  assert.equal(timed("(?:a".repeat(100_000) + ")".repeat(100_000)), "<nil>");
  assert.equal(timed("\\pL\\d[a-z]{2}".repeat(100_000)), "<nil>");
});
