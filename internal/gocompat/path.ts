// Go's package path: slash-separated paths, whatever the host system. On
// Unix, path/filepath's Join, Dir, Base and IsAbs are the same functions.
// node:path/posix.normalize is not Go's Clean: it keeps a trailing slash and
// turns "" into ".", but keeps "./" prefixes and "a/" differently.

import { utf8Bytes } from "./strings.ts";
import { decodeRune, RuneError } from "./utf8.ts";

/**
 * clean is Go's path.Clean: the shortest path equal to p, with repeated
 * slashes, "." elements and inner ".." elements removed, no trailing slash,
 * ".." at the start of a rooted path dropped, and "." for an empty result.
 */
export function clean(p: string): string {
  if (p === "") {
    return ".";
  }
  const rooted = p.startsWith("/");
  const out: string[] = [];
  let leadingDotDots = 0; // ".." elements that could not go back further
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > leadingDotDots) {
        out.pop();
      } else if (!rooted) {
        out.push("..");
        leadingDotDots++;
      }
      continue;
    }
    out.push(part);
  }
  const joined = (rooted ? "/" : "") + out.join("/");
  return joined === "" ? "." : joined;
}

// join is path.Join (and filepath.Join on Unix): the non-empty elements joined by "/" and cleaned.
export function join(...elems: string[]): string {
  const parts = elems.filter((e) => e !== "");
  return parts.length === 0 ? "" : clean(parts.join("/"));
}

// dir is path.Dir (and filepath.Dir on Unix).
export function dir(path: string): string {
  const i = path.lastIndexOf("/");
  return clean(path.slice(0, i + 1));
}

// base is path.Base (and filepath.Base on Unix).
export function base(path: string): string {
  if (path === "") return ".";
  let p = path;
  while (p.length > 0 && p.endsWith("/")) p = p.slice(0, -1);
  const i = p.lastIndexOf("/");
  if (i >= 0) p = p.slice(i + 1);
  return p === "" ? "/" : p;
}

// ext is path.Ext: the suffix from the last dot of the last element, so
// ".env" is its own extension (Node's extname gives "").
export function ext(path: string): string {
  for (let i = path.length - 1; i >= 0 && path[i] !== "/"; i--) {
    if (path[i] === ".") return path.slice(i);
  }
  return "";
}

// split is path.Split: the directory with its trailing slash, and the file.
export function split(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return [path.slice(0, i + 1), path.slice(i + 1)];
}

// isAbs is path.IsAbs.
export function isAbs(path: string): boolean {
  return path.startsWith("/");
}

// match is path.Match. It returns undefined for a malformed pattern, where
// Go returns ErrBadPattern.
export function match(pattern: string, name: string): boolean | undefined {
  return matchBytes(utf8Bytes(pattern), utf8Bytes(name));
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
