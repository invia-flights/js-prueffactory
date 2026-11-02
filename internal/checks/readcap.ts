// Host-side reads of project files.
//
// The Snapshot is a copy of untrusted input. A native Check that reads a file
// into memory reads only a regular file (never a symbolic link or named pipe)
// and only up to maxProjectFileBytes. A larger file is not read: the Check
// names it in a Limitation and goes on.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";

import { pathError } from "../gocompat/os.ts";
import type { Limitation } from "../resultset/types.ts";
import { cutList } from "./cut_text.ts";

/**
 * maxProjectFileBytes is the size above which a native Check does not read a
 * project file into memory.
 */
export const maxProjectFileBytes = 16 << 20;

/**
 * reasonTooLarge is the Limitation code for files left unread because of
 * maxProjectFileBytes.
 */
export const reasonTooLarge = "files_too_large_to_read";

/**
 * tooLargeLimitation names the files a Check left unread because of their
 * size, at most 20 of them, or returns nothing when there are none.
 */
export function tooLargeLimitation(
  checkID: string,
  paths: readonly string[],
): Limitation[] {
  if (paths.length === 0) {
    return [];
  }
  return [
    {
      reason_code: reasonTooLarge,
      message: `${String(paths.length)} file(s) are over ${String(maxProjectFileBytes >> 20)} MiB and were not read: ${cutList(paths, 20).join(", ")}`,
      check_id: checkID,
      path: null,
    },
  ];
}

/**
 * errNotRegular marks a project file that is a symlink or another special
 * file. Native Checks leave those alone: they never follow links out of the
 * Snapshot.
 */
export const errNotRegular = new Error("not a regular file");

/** errTooLarge marks a regular project file over maxProjectFileBytes. */
export const errTooLarge = new Error("file is over the size limit for reading");

/**
 * lstatRegular returns the size of the regular file at abs, or undefined for
 * a link, a special file or a path that cannot be read (Go: an Lstat whose
 * mode is not regular).
 */
export function lstatRegular(abs: string): number | undefined {
  try {
    const info = lstatSync(abs);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * readUpTo reads at most n bytes from the start of the file at abs, following
 * no link check of its own (call lstatRegular first). It throws Go's
 * *PathError for an open or read failure.
 */
export function readUpTo(abs: string, n: number): Uint8Array {
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch (err) {
    throw pathError("open", abs, err);
  }
  try {
    const buf = Buffer.alloc(Math.min(n, 1 << 20));
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < n) {
      let got: number;
      try {
        got = readSync(fd, buf, 0, Math.min(buf.length, n - total), null);
      } catch (err) {
        throw pathError("read", abs, err);
      }
      if (got === 0) {
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, got)));
      total += got;
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * readCapped reads the regular file at abs, up to limit bytes. It throws
 * errNotRegular for a link or special file, errTooLarge for a file over the
 * limit, and Go's *PathError when the file cannot be read.
 */
export function readCapped(abs: string, limit: number): Uint8Array {
  let info;
  try {
    info = lstatSync(abs);
  } catch (err) {
    throw pathError("lstat", abs, err);
  }
  if (!info.isFile()) {
    throw errNotRegular;
  }
  if (info.size > limit) {
    throw errTooLarge;
  }
  const data = readUpTo(abs, limit + 1);
  if (data.length > limit) {
    throw errTooLarge;
  }
  return data;
}

// fileHashes caches sha256File: a Check that reports many Findings in one
// file would otherwise read that file once per Location. The key is the
// path with the size and modification time of the state that was hashed.
const fileHashes = new Map<string, string>();

/**
 * sha256File streams the regular file at abs through SHA-256. It returns the
 * empty string for anything but a regular file, and for a read error.
 */
export function sha256File(abs: string): string {
  let info;
  try {
    info = lstatSync(abs, { bigint: true });
  } catch {
    return "";
  }
  if (!info.isFile()) {
    return "";
  }
  const key = `${abs}\x00${String(info.size)}\x00${String(info.mtimeNs)}`;
  const known = fileHashes.get(key);
  if (known !== undefined) {
    return known;
  }
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch {
    return "";
  }
  const h = createHash("sha256");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null);
      if (got === 0) {
        break;
      }
      h.update(buf.subarray(0, got));
    }
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
  const sum = h.digest("hex");
  fileHashes.set(key, sum);
  return sum;
}
