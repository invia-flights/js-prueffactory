// Go's path/filepath functions that differ from package path or touch the
// file system, for Unix paths. Node's path.relative and fs.realpath differ
// in the corners (trailing slashes, "..", where a walk stops), and those
// corners decide what a Snapshot keeps.
import { lstatSync, readlinkSync } from "node:fs";

import { fsPath, GoError, pathError } from "./os.ts";
import { clean, isAbs } from "./path.ts";

// rel is filepath.Rel. It returns undefined where Go returns an error.
export function rel(basePath: string, targPath: string): string | undefined {
  let b = clean(basePath);
  const t = clean(targPath);
  if (t === b) return ".";
  if (b === ".") b = "";
  if (b.startsWith("/") !== t.startsWith("/")) return undefined;
  const bl = b.length;
  const tl = t.length;
  let b0 = 0;
  let bi = 0;
  let t0 = 0;
  let ti = 0;
  for (;;) {
    while (bi < bl && b[bi] !== "/") bi++;
    while (ti < tl && t[ti] !== "/") ti++;
    if (t.slice(t0, ti) !== b.slice(b0, bi)) break;
    if (bi < bl) bi++;
    if (ti < tl) ti++;
    b0 = bi;
    t0 = ti;
  }
  if (b.slice(b0, bi) === "..") return undefined;
  if (b0 !== bl) {
    const seps = b.slice(b0, bl).split("/").length - 1;
    let out = ".." + "/..".repeat(seps);
    if (t0 !== tl) out += "/" + t.slice(t0);
    return out;
  }
  return t.slice(t0);
}

// evalSymlinks is filepath.EvalSymlinks: it walks the path one element at
// a time with lstat and readlink, so its errors name the element where the
// walk stopped, as Go's do. path, the result and the paths in the error
// texts are byte strings (see byteString), so names that are not valid
// UTF-8 survive.
export function evalSymlinks(path: string): string {
  let vol = isAbs(path) ? "/" : "";
  let volLen = vol.length;
  let dest = vol;
  let linksWalked = 0;
  let start = volLen;
  let end: number;
  for (; start < path.length; start = end) {
    while (start < path.length && path[start] === "/") start++;
    end = start;
    while (end < path.length && path[end] !== "/") end++;
    const elem = path.slice(start, end);
    if (end === start) break;
    if (elem === ".") continue;
    if (elem === "..") {
      let r = dest.length - 1;
      while (r >= volLen && dest[r] !== "/") r--;
      if (r < volLen || dest.slice(r + 1) === "..") {
        if (dest.length > volLen) dest += "/";
        dest += "..";
      } else {
        dest = dest.slice(0, r);
      }
      continue;
    }
    if (dest.length > 0 && !dest.endsWith("/")) dest += "/";
    dest += elem;
    let isLink: boolean;
    let isDir: boolean;
    try {
      const st = lstatSync(fsPath(dest));
      isLink = st.isSymbolicLink();
      isDir = st.isDirectory();
    } catch (err) {
      throw pathError("lstat", dest, err);
    }
    if (!isLink) {
      if (!isDir && end < path.length) throw new GoError("not a directory");
      continue;
    }
    linksWalked++;
    if (linksWalked > 255) throw new GoError("EvalSymlinks: too many links");
    let link: string;
    try {
      link = readlinkSync(fsPath(dest), { encoding: "buffer" }).toString(
        "latin1",
      );
    } catch (err) {
      throw pathError("readlink", dest, err);
    }
    path = link + path.slice(end);
    if (link.startsWith("/")) {
      dest = "/";
      end = 1;
      vol = "/";
      volLen = 1;
    } else {
      let r = dest.length - 1;
      while (r >= volLen && dest[r] !== "/") r--;
      dest = r < volLen ? vol : dest.slice(0, r);
      end = 0;
    }
  }
  return clean(dest);
}
