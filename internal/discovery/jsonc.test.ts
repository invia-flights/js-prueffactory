import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { unmarshal } from "../gocompat/unmarshal.ts";
import { stripJSONC } from "./discovery.ts";

test("stripJSONC blanks comments and trailing commas and keeps every offset", () => {
  const input = '{\n // c\n "a": "x // y", /* z\n */ "b": [1,],\n}';
  const out = Buffer.from(stripJSONC(Buffer.from(input), true)).toString();
  assert.equal(out, '{\n     \n "a": "x // y",     \n    "b": [1 ] \n}');
  assert.equal(out.length, input.length);
  // An unclosed block comment stays, so the JSON parser reports it.
  assert.equal(
    Buffer.from(stripJSONC(Buffer.from('{"a":1 /* open'), false)).toString(),
    '{"a":1 /* open',
  );
});

// Every JSON file under testdata/, stripped as tsconfig.json is, is accepted
// or rejected as Go did (recorded in gocompat's yaml-oracle.json).
test("every JSON file under testdata/ reads as JSONC as in Go", () => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const oracle = JSON.parse(
    readFileSync(
      path.join(repo, "internal/gocompat/testdata/yaml-oracle.json"),
      "utf8",
    ),
  ) as { json: { path: string; jsoncError?: string }[] };
  for (const c of oracle.json) {
    const data = readFileSync(path.join(repo, c.path));
    let got: string | undefined;
    try {
      unmarshal(stripJSONC(data, true), { kind: "any" });
    } catch (e) {
      got = e instanceof Error ? e.message : String(e);
    }
    assert.equal(got, c.jsoncError, c.path);
  }
});
