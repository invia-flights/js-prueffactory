// The one place that reads an untrusted file from the host (no Go
// counterpart: Go called os.ReadFile or os.Root where it wanted a guard).
//
// Everything the tool reads from the project or from a `.git` folder is
// untrusted input: a file may be a named pipe that blocks the open, a device,
// a huge file, or a symbolic link to a file outside the project. readRegular
// is the single implementation of the guard, and its result says exactly why
// a file was not read, so each caller decides what that means for it:
//
//   - lstat first: opening a named pipe for reading would block, and a link
//     is never silently followed;
//   - open with O_NONBLOCK (a pipe swapped in after the lstat must not block
//     the open) and, since the link question is settled by then, O_NOFOLLOW;
//   - fstat the opened file and refuse anything but a regular file (the path
//     may have been swapped after the lstat);
//   - read at most limit + 1 bytes, so a file that grew after the check is
//     noticed.
//
// With `root`, a symbolic link (in the file name or in a folder on the way)
// is followed, but only when the real path of the file stays inside the real
// path of root; one that leaves it is refused as "outside".
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";

/** Op names the system call that failed. */
export type Op = "lstat" | "realpath" | "open" | "read";

/** ReadOutcome is what readRegular found; "ok" is the only one with content. */
export type ReadOutcome =
  /** data is the content (with over "truncate", at most limit bytes of it). */
  | { kind: "ok"; data: Buffer }
  /** outside: with a root, the real path of the file is not inside it. */
  | { kind: "outside"; resolved: string }
  /** not_regular: a symbolic link (without a root), a folder, a pipe or a device. */
  | { kind: "not_regular" }
  /** too_large: with over "refuse", the file has more than limit bytes. */
  | { kind: "too_large" }
  /** failed: a system call failed (a missing file is op "lstat" with ENOENT, or "realpath" with a root). */
  | { kind: "failed"; op: Op; error: unknown };

/** ReadOptions say how far a read may go. */
export interface ReadOptions {
  /** limit is the size in bytes beyond which the file is too large (or cut). */
  limit: number;
  /** over says what a file larger than limit gives: "refuse" is too_large, "truncate" its first limit bytes. */
  over: "refuse" | "truncate";
  /** root, when set, lets symbolic links be followed as long as the real path stays inside root. */
  root?: string;
}

/** readRegular reads the regular file at path (a path or the bytes of one) as the options allow. */
export function readRegular(
  path: string | Buffer,
  opts: ReadOptions,
): ReadOutcome {
  let target = path;
  if (opts.root !== undefined) {
    const resolved = resolveInside(path, opts.root);
    if ("refused" in resolved) {
      return resolved.refused;
    }
    target = resolved.path;
  }
  let st;
  try {
    st = lstatSync(target);
  } catch (error) {
    return { kind: "failed", op: "lstat", error };
  }
  if (!st.isFile()) {
    return { kind: "not_regular" };
  }
  if (opts.over === "refuse" && st.size > opts.limit) {
    return { kind: "too_large" };
  }
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return { kind: "failed", op: "open", error };
  }
  try {
    let regular = false;
    try {
      regular = fstatSync(fd).isFile();
    } catch {
      // read as not regular
    }
    if (!regular) {
      return { kind: "not_regular" };
    }
    return readUpTo(fd, opts);
  } finally {
    closeSync(fd);
  }
}

// resolveInside returns the real path of path when it lies inside the real
// path of root, and the outcome "outside" or the failure of realpath
// otherwise.
function resolveInside(
  path: string | Buffer,
  root: string,
): { path: string | Buffer } | { refused: ReadOutcome } {
  let realRoot: string;
  let resolved: string | Buffer;
  try {
    realRoot = realpathSync(root);
    resolved = Buffer.isBuffer(path)
      ? realpathSync(path, "buffer")
      : realpathSync(path);
  } catch (error) {
    return { refused: { kind: "failed", op: "realpath", error } };
  }
  const text = resolved.toString();
  if (text !== realRoot && !text.startsWith(realRoot + "/")) {
    return { refused: { kind: "outside", resolved: text } };
  }
  return { path: resolved };
}

// readUpTo reads from an opened file until its end, or until over "truncate"
// has limit bytes, or until over "refuse" has seen limit + 1 bytes.
function readUpTo(fd: number, opts: ReadOptions): ReadOutcome {
  const want = opts.over === "refuse" ? opts.limit + 1 : opts.limit;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < want) {
    const buf = Buffer.alloc(Math.min(1 << 20, want - total));
    let got: number;
    try {
      got = readSync(fd, buf, 0, buf.length, null);
    } catch (error) {
      return { kind: "failed", op: "read", error };
    }
    if (got === 0) {
      break;
    }
    chunks.push(got === buf.length ? buf : buf.subarray(0, got));
    total += got;
  }
  if (opts.over === "refuse" && total > opts.limit) {
    return { kind: "too_large" };
  }
  return { kind: "ok", data: Buffer.concat(chunks, total) };
}
