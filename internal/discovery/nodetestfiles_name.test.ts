import assert from "node:assert/strict";
import { test } from "node:test";

import { isNodeTestName } from "./nodetestfiles.ts";

test("isNodeTestName equals the regular expression it replaces", () => {
  // The rule as a regular expression, which backtracks quadratically on a
  // long name; here only short generated names go through it.
  // eslint-disable-next-line regexp/no-super-linear-move -- the reference, run on short strings only
  const reference = /^test$|^test-[^\n]+|[^\n]+[.\-_]test$/;
  const parts = ["test", "-", "_", ".", "a", "\n", "x", "test-", ""];
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const names = new Set<string>(["test", "test-", "test-a", "a.test", ".test"]);
  for (let i = 0; i < 20000; i++) {
    let name = "";
    for (let k = next(5); k >= 0; k--) {
      name += parts[next(parts.length)] ?? "";
    }
    names.add(name);
  }
  for (const name of names) {
    assert.equal(
      isNodeTestName(name),
      reference.test(name),
      JSON.stringify(name),
    );
  }
});

test("a long name does not take long", () => {
  const start = Date.now();
  assert.equal(isNodeTestName("a".repeat(1_000_000) + "x"), false);
  assert.ok(Date.now() - start < 1000);
});
