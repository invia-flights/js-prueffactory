import { fsPath, GoError, pathError } from "../gocompat/os.ts";
import { readRegular as readSafely } from "../safefile/safefile.ts";

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
// a byte string. The guard is safefile's; this function gives its outcomes
// Go's error texts.
export function readRegular(
  path: string,
  limit: number,
  signal?: AbortSignal,
): string {
  checkSignal(signal);
  const r = readSafely(fsPath(path), { limit, over: "refuse" });
  switch (r.kind) {
    case "ok":
      return r.data.toString("latin1");
    case "failed":
      throw pathError(r.op, path, r.error);
    case "too_large":
      throw new GoError(`${path} is larger than ${String(limit)} bytes`);
    case "not_regular":
    case "outside":
      throw new GoError(`${path} is not a regular file`);
  }
}
