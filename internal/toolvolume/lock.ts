// The host-side lock that protects the shared cache volumes (Go: lock.go):
// whoever holds it may fill or remove them. Go takes flock(2) on the lock
// file, which the kernel releases when the process dies. Node has no flock,
// so this port has two kinds:
//
//   - "flock" (macOS): the lock file is opened with O_EXLOCK, the BSD open
//     flag that takes the same lock as flock(2). It is Go's lock on the same
//     file, so a Go Run and a TypeScript Run exclude each other, and the
//     kernel releases it when the process dies.
//   - "owner-file" (every other system, Linux among them): <lock>.owner is
//     created atomically with link(2) and names its holder ("pid host
//     nonce"); the holder touches it every ten seconds. A waiter removes it
//     when its holder is a dead process on this host, or when it was not
//     touched for two minutes (a holder on another host, or a reused PID).
//     It excludes TypeScript Runs only: a Go Run on the same host takes its
//     flock on <lock> and does not see the owner file, so a Go Run and a
//     TypeScript Run may fill the same toolset volume at the same time.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";

import { contextError } from "../docker/common.ts";
import { errnoCode, errnoText, mkdirAll, pathError } from "../gocompat/os.ts";
import { dir } from "../gocompat/path.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** Lock is a held lock; release gives it up. */
export interface Lock {
  release(): void;
}

/** LockKind is how the lock is taken; see the top of this file. */
export type LockKind = "flock" | "owner-file";

/** defaultLockKind is the kind acquire takes on this system. */
export function defaultLockKind(): LockKind {
  return process.platform === "darwin" ? "flock" : "owner-file";
}

/**
 * acquire waits for the lock on path, creating the file and its folder. It
 * returns when the lock is held and throws when the signal ends ("context
 * canceled" or "context deadline exceeded").
 */
export function acquire(signal: AbortSignal, path: string): Promise<Lock> {
  return acquireWith(defaultLockKind(), signal, path);
}

/** acquireWith is acquire with a given kind of lock, for tests. */
export async function acquireWith(
  kind: LockKind,
  signal: AbortSignal,
  path: string,
): Promise<Lock> {
  try {
    mkdirAll(dir(path), 0o755);
  } catch (err) {
    throw new Error(`cannot create the cache folder: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  const attempt = kind === "flock" ? flock(path) : ownerFileLock(path);
  try {
    for (;;) {
      const l = attempt.try();
      if (l !== null) {
        return l;
      }
      if (signal.aborted) {
        throw contextError(signal);
      }
      await wait(signal, pollMs);
    }
  } finally {
    attempt.close();
  }
}

/** pollMs is how often a waiter tries again, as in Go. */
const pollMs = 100;

interface Attempt {
  /** try returns the lock when it could be taken now, or null. */
  try(): Lock | null;
  /** close frees what the attempts needed. */
  close(): void;
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

// --- flock (macOS) ---

/** O_EXLOCK is the BSD open flag that takes an exclusive flock(2) lock. */
const O_EXLOCK = 0x20;

function flock(path: string): Attempt {
  return {
    try() {
      let fd: number;
      try {
        fd = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            O_EXLOCK |
            constants.O_NONBLOCK,
          0o644,
        );
      } catch (err) {
        const code = errnoCode(err);
        if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") {
          return null;
        }
        throw new Error(
          `cannot open the lock file: ${pathError("open", path, err).message}`,
          { cause: err },
        );
      }
      return {
        release() {
          // Closing the only descriptor gives the lock up.
          try {
            closeSync(fd);
          } catch {
            // already closed
          }
        },
      };
    },
    close() {
      // nothing to free
    },
  };
}

// --- owner file (Linux and the rest) ---

/** ownerFile is the file that names the holder of an owner-file lock on path. */
export function ownerFile(path: string): string {
  return path + ".owner";
}

/** heartbeatMs is how often a holder touches its owner file. */
const heartbeatMs = 10_000;
/** staleAfterMs is how old an untouched owner file may get before it counts as abandoned. */
const staleAfterMs = 120_000;
/** breakerStaleAfterMs: the breaker is held for a few system calls only. */
const breakerStaleAfterMs = 10_000;

function ownerFileLock(path: string): Attempt {
  const owner = ownerFile(path);
  const token = `${String(process.pid)} ${hostname()} ${randomBytes(8).toString("hex")}\n`;
  // The token is written to a file of its own first and then linked to the
  // owner file, so the owner file never exists without its content.
  const mine = `${owner}.${randomBytes(8).toString("hex")}.tmp`;
  let written = false;
  return {
    try() {
      if (!written) {
        try {
          writeFileSync(mine, token, { mode: 0o644, flag: "wx" });
        } catch (err) {
          throw new Error(
            `cannot open the lock file: ${pathError("open", mine, err).message}`,
            { cause: err },
          );
        }
        written = true;
      }
      try {
        linkSync(mine, owner);
      } catch (err) {
        if (errnoCode(err) !== "EEXIST") {
          throw new Error(`cannot lock ${path}: ${errnoText(err)}`, {
            cause: err,
          });
        }
        breakIfStale(owner);
        return null;
      }
      return heldOwnerFile(owner, token);
    },
    close() {
      if (written) {
        removeQuietly(mine);
      }
    },
  };
}

function heldOwnerFile(owner: string, token: string): Lock {
  const beat = setInterval(() => {
    if (readQuietly(owner) === token) {
      const now = new Date();
      try {
        utimesSync(owner, now, now);
      } catch {
        // gone; the next waiter will take over
      }
    }
  }, heartbeatMs);
  beat.unref();
  return {
    release() {
      clearInterval(beat);
      if (readQuietly(owner) === token) {
        removeQuietly(owner);
      }
    },
  };
}

/**
 * breakIfStale removes the owner file when its holder is gone. Two waiters
 * may find the same stale owner at once; the breaker file, created with
 * O_EXCL, lets only one of them check again and remove it, so a lock that a
 * waiter has just taken over is never removed by another.
 */
function breakIfStale(owner: string): void {
  const seen = readQuietly(owner);
  if (seen === null || !isStale(owner, seen)) {
    return;
  }
  const breaker = owner + ".break";
  let fd: number;
  try {
    fd = openSync(breaker, "wx", 0o644);
  } catch (err) {
    if (errnoCode(err) === "EEXIST" && ageMs(breaker) > breakerStaleAfterMs) {
      removeQuietly(breaker);
    }
    return;
  }
  closeSync(fd);
  try {
    if (readQuietly(owner) === seen && isStale(owner, seen)) {
      removeQuietly(owner);
    }
  } finally {
    removeQuietly(breaker);
  }
}

function isStale(owner: string, content: string): boolean {
  const [pid, host] = content.split(" ");
  if (host === hostname() && pid !== undefined && /^[0-9]+$/.test(pid)) {
    if (!alive(Number(pid))) {
      return true;
    }
  }
  return ageMs(owner) > staleAfterMs;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readQuietly(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}
