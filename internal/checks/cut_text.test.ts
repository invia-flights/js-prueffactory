import assert from "node:assert/strict";
import { test } from "node:test";

import { cutBytes, cutList, lastBytes, shorten, tail } from "./cut_text.ts";

test("cuts end between characters whatever the cut point", () => {
  const text = "a€b".repeat(40); // 3-byte characters at every offset
  const bytes = Buffer.byteLength(text);
  for (let n = 0; n < bytes; n++) {
    for (const [name, got] of [
      ["cutBytes", cutBytes(text, n)],
      ["shorten", shorten(text, n)],
      ["lastBytes", lastBytes(text, n)],
      ["tail", tail(text, n)],
    ] as const) {
      assert.ok(!got.includes("�"), `${name}(${String(n)}) = ${got}`);
      assert.ok(Buffer.byteLength(got) <= n + 3, `${name}(${String(n)})`);
    }
    assert.ok(Buffer.byteLength(cutBytes(text, n)) <= n);
    assert.ok(Buffer.byteLength(lastBytes(text, n)) <= n);
  }
  assert.equal(shorten("short", 10), "short");
  assert.equal(shorten("abcdef", 3), "abc...");
  assert.equal(tail("  abcdef  ", 3), "...def");
});

test("cutList says how many entries were left out", () => {
  assert.deepEqual(cutList(["a", "b"], 3), ["a", "b"]);
  assert.deepEqual(cutList(["a", "b", "c", "d", "e"], 3), [
    "a",
    "b",
    "c",
    "and 2 more",
  ]);
});
