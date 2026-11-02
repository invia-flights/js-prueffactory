// Go: lock_test.go, and the stale-holder rule the port adds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { background, withTimeout } from "../gocompat/context.ts";
import { millisecond } from "../gocompat/time.ts";
import { acquire } from "./lock.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "jspf-lock-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a second holder waits until the first releases the lock", async (t) => {
  const path = join(tempDir(t), "nested", "toolset.lock");
  const first = await acquire(background(), path);

  let settled = false;
  const second = acquire(background(), path).then((l) => {
    settled = true;
    return l;
  });
  await sleep(400);
  assert.equal(
    settled,
    false,
    "the second holder got the lock while the first held it",
  );

  first.release();
  const l = await second;
  l.release();
});

test("waiting for the lock ends when the Run is cancelled", async (t) => {
  const path = join(tempDir(t), "toolset.lock");
  const first = await acquire(background(), path);
  t.after(() => {
    first.release();
  });

  const ctx = withTimeout(background(), 300n * millisecond);
  const signal = ctx.signal;
  t.after(() => {
    ctx.cancel();
  });
  await assert.rejects(acquire(signal, path));
  assert.equal(signal.aborted, true);
});

test("a lock left by a process that is gone is taken over", async (t) => {
  const path = join(tempDir(t), "kubernetes-schemas.lock");
  // No process has this ID: it is above any PID limit.
  writeFileSync(path + ".holder", "2147483646\n");
  const ctx = withTimeout(background(), 2000n * millisecond);
  const signal = ctx.signal;
  t.after(() => {
    ctx.cancel();
  });
  const l = await acquire(signal, path);
  l.release();
});
