import assert from "node:assert/strict";
import { test } from "node:test";

import { background } from "../gocompat/context.ts";
import { Shared } from "./shared.ts";

test("Shared computes a value once for many callers", async () => {
  // Go: TestSharedComputesAValueOnceForManyCallers
  const s = new Shared();
  let calls = 0;
  const got = await Promise.all(
    Array.from({ length: 8 }, () =>
      s.do(background(), "k", async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [42, true];
      }),
    ),
  );
  assert.deepEqual(got, Array(8).fill(42));
  assert.equal(calls, 1);
});

test("Shared keeps different keys apart", async () => {
  // Go: TestSharedKeepsDifferentKeysApart
  const s = new Shared();
  const a = await s.do(background(), "a", () => Promise.resolve(["A", true]));
  const b = await s.do(background(), "b", () => Promise.resolve(["B", true]));
  assert.deepEqual([a, b], ["A", "B"]);
});

test("Shared does not keep a value that may have been cut short by cancellation", async () => {
  // Go: TestSharedDoesNotKeepAValueThatMayHaveBeenCutShortByCancellation
  const s = new Shared();
  await s.do(background(), "k", () => Promise.resolve(["cancelled", false]));
  const got = await s.do(background(), "k", () =>
    Promise.resolve(["fresh", true]),
  );
  assert.equal(got, "fresh");
});

test("put and get share a value with a later Check; a failing computation releases the key", async () => {
  const s = new Shared();
  assert.deepEqual(s.get("k"), [undefined, false]);
  s.put("k", 1);
  assert.deepEqual(s.get("k"), [1, true]);
  await assert.rejects(
    s.do(background(), "x", () => Promise.reject(new Error("boom"))),
  );
  assert.equal(
    await s.do(background(), "x", () => Promise.resolve(["ok", true])),
    "ok",
  );
});
