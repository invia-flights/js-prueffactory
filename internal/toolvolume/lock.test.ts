import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { withTimeout } from "../gocompat/context.ts";
import { millisecond } from "../gocompat/time.ts";
import {
  acquire,
  acquireWith,
  type LockKind,
  defaultLockKind,
  ownerFile,
} from "./lock.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

const kinds: LockKind[] =
  process.platform === "darwin" ? ["flock", "owner-file"] : ["owner-file"];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// holder starts another Node process that takes the lock and holds it until
// it is killed. It resolves once the lock is held.
async function holder(
  t: TestContext,
  kind: LockKind,
  path: string,
): Promise<ChildProcess> {
  const lockModule = new URL("lock.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireWith } from ${JSON.stringify(lockModule)};
await acquireWith(${JSON.stringify(kind)}, new AbortController().signal, ${JSON.stringify(path)});
process.stdout.write("held\\n");
setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (b: Buffer) => {
      if (b.toString().includes("held")) resolve();
    });
    child.on("exit", (code) => {
      reject(new Error(`the holder exited with ${String(code)}`));
    });
  });
  return child;
}

for (const kind of kinds) {
  test(`${kind}: a second holder waits until the first releases the lock`, async (t) => {
    const path = join(tempDir(t), "nested", "toolset.lock");
    const first = await acquireWith(kind, new AbortController().signal, path);

    let got = false;
    const second = acquireWith(kind, new AbortController().signal, path).then(
      (l) => {
        got = true;
        return l;
      },
    );
    await sleep(400);
    assert.equal(
      got,
      false,
      "the second holder got the lock while the first held it",
    );

    first.release();
    const l = await second;
    l.release();
  });

  test(`${kind}: waiting for the lock ends when the Run is cancelled`, async (t) => {
    const path = join(tempDir(t), "toolset.lock");
    const first = await acquireWith(kind, new AbortController().signal, path);
    t.after(() => {
      first.release();
    });

    const ctx = withTimeout(new AbortController().signal, 300n * millisecond);
    t.after(() => {
      ctx.cancel();
    });
    await assert.rejects(acquireWith(kind, ctx.signal, path), {
      message: "context deadline exceeded",
    });
  });

  test(`${kind}: another process holding the lock excludes this one until it dies`, async (t) => {
    const path = join(tempDir(t), "toolset.lock");
    const child = await holder(t, kind, path);

    let got = false;
    const mine = acquireWith(kind, new AbortController().signal, path).then(
      (l) => {
        got = true;
        return l;
      },
    );
    await sleep(500);
    assert.equal(
      got,
      false,
      "the lock was taken while another process held it",
    );

    // A Run that crashes never blocks the next one.
    child.kill("SIGKILL");
    const l = await mine;
    l.release();
  });
}

// Go's Runs take flock(2) on <cache>/toolset.lock. On macOS the TypeScript
// build takes the very same lock, so a Go Run and a TypeScript Run exclude
// each other; python3's fcntl.flock stands in for Go's syscall.Flock.
test("on macOS the lock is the flock that Go's Runs take on the same file", async (t) => {
  if (process.platform !== "darwin") {
    assert.equal(defaultLockKind(), "owner-file");
    t.skip("flock interoperation exists only on macOS");
    return;
  }
  assert.equal(defaultLockKind(), "flock");
  const path = join(tempDir(t), "toolset.lock");
  const l = await acquire(new AbortController().signal, path);
  const tryFlock = (): string =>
    spawnSync(
      "python3",
      [
        "-c",
        "import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry:\n  fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked')\nexcept BlockingIOError:\n  print('busy')",
        path,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
  if (spawnSync("python3", ["--version"]).status !== 0) {
    l.release();
    t.skip("python3 is not installed");
    return;
  }

  assert.equal(tryFlock(), "busy");
  l.release();
  assert.equal(tryFlock(), "locked");
});

test("owner-file: a lock of a live process on another host is broken only when its heartbeat stopped", async (t) => {
  const path = join(tempDir(t), "toolset.lock");
  const owner = ownerFile(path);
  writeFileSync(owner, "1 some-other-host abc\n");

  const ctx = withTimeout(new AbortController().signal, 300n * millisecond);
  t.after(() => {
    ctx.cancel();
  });
  await assert.rejects(acquireWith("owner-file", ctx.signal, path), {
    message: "context deadline exceeded",
  });

  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(owner, old, old);
  const l = await acquireWith("owner-file", new AbortController().signal, path);
  assert.match(
    readFileSync(owner, "utf8"),
    new RegExp(`^${String(process.pid)} `),
  );
  l.release();
});

test("owner-file: releasing never removes a lock another holder took over", async (t) => {
  const path = join(tempDir(t), "toolset.lock");
  const l = await acquireWith("owner-file", new AbortController().signal, path);
  writeFileSync(ownerFile(path), "1 some-other-host abc\n");

  l.release();

  assert.equal(
    readFileSync(ownerFile(path), "utf8"),
    "1 some-other-host abc\n",
  );
});

// From ticket 17's lock: a lock left by a process that is gone is taken over
// at once (with flock, the kernel drops the lock of a dead process itself).
test("owner-file: a lock left by a process that is gone is taken over", async (t) => {
  const path = join(tempDir(t), "kubernetes-schemas.lock");
  // No process has this ID: it is above any PID limit.
  writeFileSync(ownerFile(path), `2147483646 ${hostname()} abc\n`);
  const ctx = withTimeout(new AbortController().signal, 2000n * millisecond);
  t.after(() => {
    ctx.cancel();
  });

  const l = await acquireWith("owner-file", ctx.signal, path);

  l.release();
});
