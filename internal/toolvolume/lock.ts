// A host-side lock on a file. It protects the shared cache volumes: whoever
// holds it may fill or remove them (Go: lock.go).
//
// Go takes an flock(2) on the file, which the kernel drops when the process
// dies. Node has no flock, so the port marks the holder with a file next to
// the lock file, created exclusively and holding the process ID. A holder
// file whose process is gone, or that is older than staleAfter, is taken
// over, so a crashed Run never blocks the next one. The lock file itself is
// created as Go creates it. The two builds do not exclude each other: a Go
// Run and a TypeScript Run that fill the same cache volume at the same
// moment can both fetch, and the last one wins (traps.md).
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { processRunning } from "../docker/sweep.ts";
import { contextError } from "../docker/common.ts";
import { errnoText, mkdirAll } from "../gocompat/os.ts";

/** pollMs is how often a waiting holder looks again, as in Go. */
const pollMs = 100;

/**
 * staleAfterMs is the age after which a holder file counts as left behind,
 * whatever its process ID: longer than any install or download under a lock
 * takes, so a reused process ID cannot block the cache forever.
 */
const staleAfterMs = 60 * 60 * 1000;

/** Lock is a held lock. */
export interface Lock {
  release(): void;
}

/**
 * acquire waits for the lock on path, creating the file and its folder. It
 * resolves when the lock is held and rejects when the signal ends, with Go's
 * context error.
 */
export async function acquire(
  signal: AbortSignal,
  path: string,
): Promise<Lock> {
  try {
    mkdirAll(dirname(path), 0o755);
  } catch (err) {
    throw new Error(
      `cannot create the cache folder: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    closeSync(openSync(path, "a", 0o644));
  } catch (err) {
    throw new Error(
      `cannot open the lock file: open ${path}: ${errnoText(err)}`,
      { cause: err },
    );
  }
  const holder = path + ".holder";
  for (;;) {
    if (signal.aborted) {
      throw contextError(signal);
    }
    let fd: number | undefined;
    try {
      fd = openSync(holder, "wx", 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`cannot lock ${path}: ${errnoText(err)}`, {
          cause: err,
        });
      }
    }
    if (fd !== undefined) {
      writeSync(fd, `${String(process.pid)}\n`);
      closeSync(fd);
      return held(holder);
    }
    if (stale(holder)) {
      try {
        unlinkSync(holder);
      } catch {
        // Another waiter took it over first.
      }
      continue;
    }
    await wait(signal, pollMs);
  }
}

function held(holder: string): Lock {
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        unlinkSync(holder);
      } catch {
        // Gone already: a waiter judged it stale.
      }
    },
  };
}

/** stale says whether the holder file was left by a process that is gone. */
function stale(holder: string): boolean {
  let text: string;
  let mtime: number;
  try {
    text = readFileSync(holder, "utf8");
    mtime = statSync(holder).mtimeMs;
  } catch {
    return false; // released meanwhile: try again
  }
  if (Date.now() - mtime > staleAfterMs) {
    return true;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Being written right now, or damaged: damaged files go stale by age.
    return false;
  }
  return pid !== process.pid && !processRunning(pid);
}

function wait(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
