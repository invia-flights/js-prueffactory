// Go's path and path/filepath functions for Unix paths ("/" separated).
// Node's path module differs in the corners (trailing slashes, "", ".."),
// and those corners decide what a Snapshot keeps.
import { lstatSync, readlinkSync } from "node:fs";

import { fsPath, GoError, pathError } from "./os.ts";
import { decodeRune, RuneError, utf8 } from "./utf8.ts";

// clean is path.Clean (and filepath.Clean on Unix).
export function clean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const n = path.length;
  let out = rooted ? "/" : "";
  let r = rooted ? 1 : 0;
  let dotdot = rooted ? 1 : 0;
  while (r < n) {
    if (path[r] === "/") {
      r++;
    } else if (path[r] === "." && (r + 1 === n || path[r + 1] === "/")) {
      r++;
    } else if (
      path[r] === "." &&
      path[r + 1] === "." &&
      (r + 2 === n || path[r + 2] === "/")
    ) {
      r += 2;
      if (out.length > dotdot) {
        let w = out.length - 1;
        while (w > dotdot && out[w] !== "/") w--;
        out = out.slice(0, w);
      } else if (!rooted) {
        if (out.length > 0) out += "/";
        out += "..";
        dotdot = out.length;
      }
    } else {
      if ((rooted && out.length !== 1) || (!rooted && out.length !== 0)) {
        out += "/";
      }
      const next = path.indexOf("/", r);
      const end = next < 0 ? n : next;
      out += path.slice(r, end);
      r = end;
    }
  }
  return out === "" ? "." : out;
}

// join is filepath.Join: the non-empty elements joined by "/" and cleaned.
export function join(...elems: string[]): string {
  const parts = elems.filter((e) => e !== "");
  return parts.length === 0 ? "" : clean(parts.join("/"));
}

// dir is filepath.Dir.
export function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return clean(path.slice(0, i + 1));
}

// base is filepath.Base.
export function base(path: string): string {
  if (path === "") return ".";
  let p = path;
  while (p.length > 0 && p.endsWith("/")) p = p.slice(0, -1);
  const i = p.lastIndexOf("/");
  if (i >= 0) p = p.slice(i + 1);
  return p === "" ? "/" : p;
}

export function isAbs(path: string): boolean {
  return path.startsWith("/");
}

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

// match is path.Match. It returns undefined for a malformed pattern, where
// Go returns ErrBadPattern.
export function match(pattern: string, name: string): boolean | undefined {
  return matchBytes(utf8(pattern), utf8(name));
}

function matchBytes(
  pattern: Uint8Array,
  name: Uint8Array,
): boolean | undefined {
  let p = pattern;
  let s = name;
  outer: while (p.length > 0) {
    const [star, chunk, rest] = scanChunk(p);
    p = rest;
    if (star && chunk.length === 0) return !s.includes(0x2f);
    const first = matchChunk(chunk, s);
    if (first === badPattern) return undefined;
    if (first !== failed && (first.length === 0 || p.length > 0)) {
      s = first;
      continue;
    }
    if (star) {
      for (let i = 0; i < s.length && s[i] !== 0x2f; i++) {
        const t = matchChunk(chunk, s.subarray(i + 1));
        if (t === badPattern) return undefined;
        if (t !== failed) {
          if (p.length === 0 && t.length > 0) continue;
          s = t;
          continue outer;
        }
      }
    }
    while (p.length > 0) {
      const [, c, r] = scanChunk(p);
      p = r;
      if (matchChunk(c, new Uint8Array()) === badPattern) return undefined;
    }
    return false;
  }
  return s.length === 0;
}

function scanChunk(p: Uint8Array): [boolean, Uint8Array, Uint8Array] {
  let star = false;
  while (p.length > 0 && p[0] === 0x2a) {
    p = p.subarray(1);
    star = true;
  }
  let inrange = false;
  for (let i = 0; i < p.length; i++) {
    switch (p[i]) {
      case 0x5c:
        if (i + 1 < p.length) i++;
        break;
      case 0x5b:
        inrange = true;
        break;
      case 0x5d:
        inrange = false;
        break;
      case 0x2a:
        if (!inrange) return [star, p.subarray(0, i), p.subarray(i)];
    }
  }
  return [star, p, new Uint8Array()];
}

const failed = Symbol("failed");
const badPattern = Symbol("badPattern");

function matchChunk(
  chunk: Uint8Array,
  s: Uint8Array,
): Uint8Array | typeof failed | typeof badPattern {
  let fail = false;
  let c = chunk;
  while (c.length > 0) {
    fail ||= s.length === 0;
    switch (c[0]) {
      case 0x5b: {
        let r = 0;
        if (!fail) {
          const [dr, n] = decodeRune(s);
          r = dr;
          s = s.subarray(n);
        }
        c = c.subarray(1);
        let negated = false;
        if (c.length > 0 && c[0] === 0x5e) {
          negated = true;
          c = c.subarray(1);
        }
        let matched = false;
        let nrange = 0;
        for (;;) {
          if (c.length > 0 && c[0] === 0x5d && nrange > 0) {
            c = c.subarray(1);
            break;
          }
          const lo = getEsc(c);
          if (lo === badPattern) return badPattern;
          let hi = lo[0];
          c = lo[1];
          if (c[0] === 0x2d) {
            const h = getEsc(c.subarray(1));
            if (h === badPattern) return badPattern;
            hi = h[0];
            c = h[1];
          }
          matched ||= lo[0] <= r && r <= hi;
          nrange++;
        }
        fail ||= matched === negated;
        break;
      }
      case 0x3f:
        if (!fail) {
          fail = s[0] === 0x2f;
          const [, n] = decodeRune(s);
          s = s.subarray(n);
        }
        c = c.subarray(1);
        break;
      default:
        if (c[0] === 0x5c) {
          // An escaped byte matches itself.
          c = c.subarray(1);
          if (c.length === 0) return badPattern;
        }
        if (!fail) {
          fail = c[0] !== s[0];
          s = s.subarray(1);
        }
        c = c.subarray(1);
    }
  }
  return fail ? failed : s;
}

function getEsc(c: Uint8Array): [number, Uint8Array] | typeof badPattern {
  if (c.length === 0 || c[0] === 0x2d || c[0] === 0x5d) return badPattern;
  if (c[0] === 0x5c) {
    c = c.subarray(1);
    if (c.length === 0) return badPattern;
  }
  const [r, n] = decodeRune(c);
  const rest = c.subarray(n);
  if ((r === RuneError && n === 1) || rest.length === 0) return badPattern;
  return [r, rest];
}
