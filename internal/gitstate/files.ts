import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";

import { fsPath, GoError, pathError } from "../gocompat/os.ts";

// Size limits for files read out of an untrusted `.git` folder.
export const maxSmallFile = 64 << 10; // HEAD, loose refs, commondir, a `.git` file
export const maxPackedRefs = 4 << 20;
export const maxConfigFile = 1 << 20;

// checkSignal throws Go's context error once signal is aborted.
export function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    const timeout =
      reason instanceof DOMException && reason.name === "TimeoutError";
    throw new GoError(
      timeout ? "context deadline exceeded" : "context canceled",
    );
  }
}

// readRegular reads path (a byte string), which must be a regular file (not
// a symbolic link, named pipe or device) of at most limit bytes. The
// Original is untrusted, so a `.git` folder that swaps HEAD for a named pipe
// or a huge file must not be able to hang or exhaust the host. A file over
// the limit is an error, never a truncated read. The content comes back as
// a byte string.
export function readRegular(
  path: string,
  limit: number,
  signal?: AbortSignal,
): string {
  checkSignal(signal);
  let st;
  try {
    st = lstatSync(fsPath(path));
  } catch (err) {
    throw pathError("lstat", path, err);
  }
  if (!st.isFile()) throw new GoError(`${path} is not a regular file`);
  if (st.size > limit)
    throw new GoError(`${path} is larger than ${String(limit)} bytes`);
  let fd: number;
  try {
    // O_NONBLOCK: a named pipe swapped in after the lstat must not block
    // the open; the fstat below then refuses it.
    fd = openSync(fsPath(path), constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    throw pathError("open", path, err);
  }
  try {
    // Re-check the opened file: the path may have been swapped after the
    // lstat.
    let regular = false;
    try {
      regular = fstatSync(fd).isFile();
    } catch {
      // as not regular
    }
    if (!regular) throw new GoError(`${path} is not a regular file`);
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < buf.length) {
      let got: number;
      try {
        got = readSync(fd, buf, n, buf.length - n, null);
      } catch (err) {
        throw pathError("read", path, err);
      }
      if (got === 0) break;
      n += got;
    }
    if (n > limit)
      throw new GoError(`${path} is larger than ${String(limit)} bytes`);
    return buf.subarray(0, n).toString("latin1");
  } finally {
    closeSync(fd);
  }
}
