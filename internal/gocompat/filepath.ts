// Go's path/filepath and os file functions on Unix, with Go's error texts
// ("lstat /x: no such file or directory"), which reach usage errors. Node's
// own messages ("ENOENT: no such file or directory, lstat '/x'") differ, and
// Node's realpath does not fail where EvalSymlinks fails.

import {
  lstatSync,
  readdirSync,
  readlinkSync,
  type Stats,
  statSync,
} from "node:fs";

import { clean } from "./path.ts";
import { sortStrings } from "./strings.ts";

// Go's text of the errno values file functions return (syscall.Errno.Error).
const errnoText: Record<string, string> = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ELOOP: "too many levels of symbolic links",
  ENAMETOOLONG: "file name too long",
  EISDIR: "is a directory",
  EIO: "input/output error",
  EINVAL: "invalid argument",
  EMFILE: "too many open files",
  ENFILE: "too many open files in system",
};

function codeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const { code } = err;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/** errText is Go's Error() text of the errno behind a Node error. */
export function errText(err: unknown): string {
  return (
    errnoText[codeOf(err)] ?? (err instanceof Error ? err.message : String(err))
  );
}

/**
 * PathError is Go's *fs.PathError: "op path: errno text". code keeps the
 * Node error code (ENOENT, ...).
 */
export class PathError extends Error {
  readonly code: string;
  constructor(op: string, path: string, cause: unknown) {
    super(`${op} ${path}: ${errText(cause)}`, { cause });
    this.code = codeOf(cause);
  }
}

/** isNotExist is errors.Is(err, fs.ErrNotExist): ENOENT only. */
export function isNotExist(err: unknown): boolean {
  return codeOf(err) === "ENOENT";
}

/** lstat is os.Lstat. */
export function lstat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (err) {
    throw new PathError("lstat", path, err);
  }
}

/** stat is os.Stat. */
export function stat(path: string): Stats {
  try {
    return statSync(path);
  } catch (err) {
    throw new PathError("stat", path, err);
  }
}

/** readDirNames is the names of os.ReadDir, sorted byte-wise as Go sorts them. */
export function readDirNames(path: string): string[] {
  try {
    return sortStrings(readdirSync(path));
  } catch (err) {
    throw new PathError("open", path, err);
  }
}

function readlink(path: string): string {
  try {
    return readlinkSync(path);
  } catch (err) {
    throw new PathError("readlink", path, err);
  }
}

/** isAbs is filepath.IsAbs on Unix. */
export function isAbs(path: string): boolean {
  return path.startsWith("/");
}

/** join is filepath.Join: the non-empty elements joined by "/" and cleaned. */
export function join(...elems: string[]): string {
  const parts = elems.filter((e) => e !== "");
  return parts.length === 0 ? "" : clean(parts.join("/"));
}

/** dir is filepath.Dir: everything before the last "/", cleaned. */
export function dir(path: string): string {
  return clean(path.slice(0, path.lastIndexOf("/") + 1));
}

/** base is filepath.Base: the last element, "." for "", "/" for slashes only. */
export function base(path: string): string {
  if (path === "") {
    return ".";
  }
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") {
    return "/";
  }
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * getwd is os.Getwd: $PWD of the process when it is absolute and names the
 * working folder (so a folder reached through a symlink keeps that name),
 * else the real working folder.
 */
export function getwd(): string {
  const cwd = process.cwd();
  const pwd = process.env.PWD ?? "";
  if (pwd.startsWith("/")) {
    try {
      const a = statSync(pwd);
      const b = statSync(".");
      if (a.dev === b.dev && a.ino === b.ino) {
        return pwd;
      }
    } catch {
      // fall back to the real working folder
    }
  }
  return cwd;
}

/** abs is filepath.Abs. */
export function abs(path: string): string {
  return isAbs(path) ? clean(path) : join(getwd(), path);
}

/** tempDir is os.TempDir on Unix: $TMPDIR, else /tmp. */
export function tempDir(): string {
  const dir = process.env.TMPDIR ?? "";
  return dir === "" ? "/tmp" : dir;
}

/**
 * evalSymlinks is filepath.EvalSymlinks on Unix: every symlink in path
 * resolved, component by component, with Go's errors: "lstat <prefix>: ..."
 * for a missing component, a bare "not a directory" for a file followed by
 * more components, "EvalSymlinks: too many links" after 255 links.
 */
export function evalSymlinks(path: string): string {
  let volLen = path.startsWith("/") ? 1 : 0;
  let vol = path.slice(0, volLen);
  let dest = vol;
  let linksWalked = 0;
  for (let start = volLen, end: number; start < path.length; start = end) {
    while (start < path.length && path.charAt(start) === "/") {
      start++;
    }
    end = start;
    while (end < path.length && path.charAt(end) !== "/") {
      end++;
    }
    const component = path.slice(start, end);
    if (end === start) {
      break;
    } else if (component === ".") {
      continue;
    } else if (component === "..") {
      const r = dest.lastIndexOf("/");
      if (r < volLen || dest.slice(r + 1) === "..") {
        if (dest.length > volLen) {
          dest += "/";
        }
        dest += "..";
      } else {
        dest = dest.slice(0, r);
      }
      continue;
    }

    if (dest.length > 0 && !dest.endsWith("/")) {
      dest += "/";
    }
    dest += component;

    const fi = lstat(dest);
    if (!fi.isSymbolicLink()) {
      if (!fi.isDirectory() && end < path.length) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      continue;
    }

    linksWalked++;
    if (linksWalked > 255) {
      throw new Error("EvalSymlinks: too many links");
    }
    const link = readlink(dest);
    path = link + path.slice(end);
    if (link.startsWith("/")) {
      dest = "/";
      end = 1;
      vol = "/";
      volLen = 1;
    } else {
      const r = dest.lastIndexOf("/");
      dest = r < volLen ? vol : dest.slice(0, r);
      end = 0;
    }
  }
  return clean(dest);
}
