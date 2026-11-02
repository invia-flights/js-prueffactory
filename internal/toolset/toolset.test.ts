import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { version } from "./all.ts";
import { tableLines } from "./toolset.ts";

// The Go build's table and version at the freeze commit, recorded by
// testdata/go-oracle.go.txt.
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { lines: string[]; version: string };

test("the toolset table holds the Go build's entries, line for line", () => {
  assert.deepEqual(tableLines(), oracle.lines);
});

test("the toolset version is the Go build's", () => {
  assert.equal(version(), oracle.version);
});
