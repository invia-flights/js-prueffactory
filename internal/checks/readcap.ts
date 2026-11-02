// Host-side reads of project files.
//
// The Snapshot is a copy of untrusted input. A native Check that reads a file
// into memory reads only a regular file (never a symbolic link or named pipe)
// and only up to maxProjectFileBytes. A larger file is not read: the Check
// names it in a Limitation and goes on.
import { closeSync, lstatSync, openSync, readSync } from "node:fs";

import { pathError } from "../gocompat/os.ts";

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
