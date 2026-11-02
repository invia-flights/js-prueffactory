// Error texts as Go's os package prints them ("open /x: permission denied").
// They end up in Limitations and Findings, so the port writes Go's words
// instead of Node's ("EACCES: permission denied, open '/x'").
import { closeSync, openSync, readFileSync } from "node:fs";
import process from "node:process";

import { goString } from "./utf8.ts";

// Go keeps file names as bytes. Code that must not lose a name that is not
// valid UTF-8 holds it as a byte string: one character per byte (latin1).
// Comparing byte strings with < is byte-wise order.

// byteString turns a (UTF-8) string into a byte string.
export function byteString(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

// fromByteString turns a byte string into text the way Go's JSON encoder
// writes a Go string: each invalid byte becomes U+FFFD.
export function fromByteString(b: string): string {
  return goString(Buffer.from(b, "latin1"));
}

// fsPath turns a byte string into a path for the fs functions.
export function fsPath(b: string): Buffer {
  return Buffer.from(b, "latin1");
}

// readFile is os.ReadFile: an error names the call that failed, "open" or
// "read" (a folder opens, and reading it fails).
export function readFile(path: string): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    throw pathError("open", path, err);
  }
  try {
    return readFileSync(fd);
  } catch (err) {
    throw pathError("read", path, err);
  } finally {
    closeSync(fd);
  }
}

// GoError carries the text a Go error would print, and whether Go's
// errors.Is(err, fs.ErrNotExist) holds for it.
export class GoError extends Error {
  readonly notExist: boolean;
  constructor(message: string, notExist = false) {
    super(message);
    this.name = "GoError";
    this.notExist = notExist;
  }
}

// pathError is Go's *fs.PathError for a failed system call on path.
export function pathError(op: string, path: string, err: unknown): GoError {
  return new GoError(`${op} ${path}: ${errnoText(err)}`, isNotExist(err));
}

// isNotExist is errors.Is(err, fs.ErrNotExist) for a Node system error.
export function isNotExist(err: unknown): boolean {
  if (err instanceof GoError) return err.notExist;
  return errnoCode(err) === "ENOENT";
}

export function errnoCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = err.code;
    if (typeof code === "string") return code;
  }
  return "";
}

// errnoText is the text of Go's syscall.Errno for the error's code on this
// platform, or Node's own description for a code the table lacks.
export function errnoText(err: unknown): string {
  if (err instanceof GoError) return err.message;
  const code = errnoCode(err);
  const own = errnoTexts[code];
  if (own !== undefined) {
    return process.platform === "darwin" ? own[0] : own[1];
  }
  const message = err instanceof Error ? err.message : String(err);
  // Node: "EACCES: permission denied, open '/x'".
  const m = /^[A-Z0-9]+: (.*?)(?:, \w+ .*)?$/.exec(message);
  return m?.[1] ?? message;
}

// [darwin, linux] texts of Go 1.27's syscall error tables.
const errnoTexts: Record<string, readonly [string, string]> = {
  EACCES: ["permission denied", "permission denied"],
  ENOENT: ["no such file or directory", "no such file or directory"],
  ENOTDIR: ["not a directory", "not a directory"],
  ELOOP: [
    "too many levels of symbolic links",
    "too many levels of symbolic links",
  ],
  EIO: ["input/output error", "input/output error"],
  EPERM: ["operation not permitted", "operation not permitted"],
  EISDIR: ["is a directory", "is a directory"],
  ENAMETOOLONG: ["file name too long", "file name too long"],
  EMFILE: ["too many open files", "too many open files"],
  ENFILE: ["too many open files in system", "too many open files in system"],
  EBUSY: ["resource busy", "device or resource busy"],
  ENXIO: ["device not configured", "no such device or address"],
  EINVAL: ["invalid argument", "invalid argument"],
  EAGAIN: [
    "resource temporarily unavailable",
    "resource temporarily unavailable",
  ],
  EINTR: ["interrupted system call", "interrupted system call"],
  ENOMEM: ["cannot allocate memory", "cannot allocate memory"],
  ETIMEDOUT: ["operation timed out", "connection timed out"],
  EEXIST: ["file exists", "file exists"],
  ENOSPC: ["no space left on device", "no space left on device"],
  EROFS: ["read-only file system", "read-only file system"],
  EFAULT: ["bad address", "bad address"],
  EBADF: ["bad file descriptor", "bad file descriptor"],
  ESTALE: ["stale NFS file handle", "stale file handle"],
  EOVERFLOW: [
    "value too large to be stored in data type",
    "value too large for defined data type",
  ],
  EDEADLK: ["resource deadlock avoided", "resource deadlock avoided"],
  ENODEV: ["operation not supported by device", "no such device"],
  EXDEV: ["cross-device link", "invalid cross-device link"],
  ETXTBSY: ["text file busy", "text file busy"],
  ENOTSUP: ["operation not supported", "operation not supported"],
  EOPNOTSUPP: ["operation not supported on socket", "operation not supported"],
  ENOSYS: ["function not implemented", "function not implemented"],
  ECANCELED: ["operation canceled", "operation canceled"],
  EILSEQ: [
    "illegal byte sequence",
    "invalid or incomplete multibyte or wide character",
  ],
};
