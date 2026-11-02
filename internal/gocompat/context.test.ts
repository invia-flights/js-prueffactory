import assert from "node:assert/strict";
import { test } from "node:test";

import { contextError } from "../docker/common.ts";
import {
  background,
  deadline,
  isDeadline,
  withCancel,
  withDeadline,
  withTimeout,
} from "./context.ts";
import { hour } from "./time.ts";

test("a cancelled signal says context canceled, a passed deadline context deadline exceeded", () => {
  const c = withCancel();
  c.cancel();
  assert.equal(contextError(c.signal).message, "context canceled");
  assert.ok(!isDeadline(c.signal));
  const d = withDeadline(background(), Date.now() - 1);
  assert.ok(d.signal.aborted, "a deadline in the past ends the signal at once");
  assert.ok(isDeadline(d.signal));
  assert.equal(contextError(d.signal).message, "context deadline exceeded");
  d.cancel();
  assert.ok(isDeadline(d.signal), "cancel after the end changes nothing");
});

test("a child ends with its parent and keeps the parent's reason", () => {
  const parent = withDeadline(background(), Date.now() - 1);
  const child = withCancel(parent.signal);
  assert.ok(child.signal.aborted && isDeadline(child.signal));

  const run = withCancel();
  const budget = withTimeout(run.signal, hour);
  run.cancel();
  assert.ok(budget.signal.aborted && !isDeadline(budget.signal));
  budget.cancel();
});

test("a deadline fires, and one beyond Node's timer limit does not fire at once", async () => {
  const soon = withTimeout(background(), 5_000_000n); // 5 ms
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(isDeadline(soon.signal));

  // 600h: a plain setTimeout of that many milliseconds would fire after 1 ms.
  const far = withTimeout(background(), 600n * hour);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!far.signal.aborted);
  far.cancel();
  assert.ok(!isDeadline(far.signal) && far.signal.reason !== undefined);
});

test("a signal's deadline is the earliest of its own and its parents', as ctx.Deadline", () => {
  assert.equal(deadline(background()), undefined);
  const at = Date.now() + 60_000;
  const budget = withDeadline(background(), at);
  const exec = withTimeout(budget.signal, hour);
  const child = withCancel(exec.signal);
  const sooner = withDeadline(budget.signal, at - 1000);
  assert.equal(deadline(budget.signal), at);
  assert.equal(
    deadline(exec.signal),
    at,
    "a later timeout keeps the parent's deadline",
  );
  assert.equal(deadline(child.signal), at, "withCancel inherits the deadline");
  assert.equal(deadline(sooner.signal), at - 1000);
  for (const c of [budget, exec, child, sooner]) c.cancel();
});
