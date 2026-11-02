import { fields } from "../gocompat/strings.ts";

// NodeRange is an npm semver range, such as the one in `engines.node`,
// reduced to what the tool needs: whether some version of a given Node major
// satisfies it. Versions are encoded as one integer, major*1e12 + minor*1e6 +
// patch, so that every comparator becomes an interval. Prerelease and build
// suffixes are ignored. The integers pass 2^53, hence bigint.
export class NodeRange {
  alternatives: Interval[] = [];

  // satisfiedBy says whether some version of the Node major satisfies the
  // range.
  satisfiedBy(major: number): boolean {
    const m: Interval = {
      lo: BigInt(major) * E12,
      hi: BigInt(major + 1) * E12 - 1n,
    };
    return this.alternatives.some((alt) => !empty(intersect(alt, m)));
  }
}

// Interval is a closed range of encoded versions. It is empty when lo > hi.
interface Interval {
  lo: bigint;
  hi: bigint;
}

const E12 = 1000000000000n;
const E6 = 1000000n;
const versionMax = 99999n * E12 + 99999n * E6 + 99999n;
const componentMax = 99999n;

function intersect(a: Interval, b: Interval): Interval {
  return { lo: b.lo > a.lo ? b.lo : a.lo, hi: b.hi < a.hi ? b.hi : a.hi };
}

function empty(a: Interval): boolean {
  return a.lo > a.hi;
}

// parseNodeRange reads an npm range. It returns null for text it cannot
// understand, so that such text never decides a version. Lengths are Go's
// byte lengths.
export function parseNodeRange(s: string): NodeRange | null {
  if (Buffer.byteLength(s, "utf8") > 200) return null;
  const r = new NodeRange();
  for (const alt of s.split("||")) {
    const iv = parseComparatorSet(alt);
    if (iv === null) return null;
    r.alternatives.push(iv);
  }
  return r;
}

// parseComparatorSet reads space-separated comparators and hyphen ranges,
// all of which must hold.
function parseComparatorSet(s: string): Interval | null {
  let all: Interval = { lo: 0n, hi: versionMax };
  const tokens = fields(s);
  // ">= 1.2.3" is one comparator written with a space.
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if ([">", ">=", "<", "<=", "=", "^", "~", "~>"].includes(t)) {
      if (i + 1 < tokens.length) {
        merged.push(t + (tokens[i + 1] ?? ""));
        i++;
        continue;
      }
      return null;
    }
    merged.push(t);
  }
  for (let i = 0; i < merged.length; i++) {
    if (i + 2 < merged.length && merged[i + 1] === "-") {
      const lo = parsePartial(merged[i] ?? "");
      const hi = parsePartial(merged[i + 2] ?? "");
      if (!lo || !hi) return null;
      all = intersect(all, { lo: low(lo), hi: high(hi) });
      i += 2;
      continue;
    }
    const iv = parseComparator(merged[i] ?? "");
    if (iv === null) return null;
    all = intersect(all, iv);
  }
  return all;
}

// Partial is a version with parts that may be missing or wildcards. given
// is how many leading parts are numbers, 0 to 3.
interface Partial {
  major: bigint;
  minor: bigint;
  patch: bigint;
  given: number;
}

function enc(major: bigint, minor: bigint, patch: bigint): bigint {
  return major * E12 + minor * E6 + patch;
}

// low is the lowest version the partial stands for.
function low(p: Partial): bigint {
  return enc(p.major, p.minor, p.patch);
}

// high is the highest version the partial stands for: 1.2 means up to
// 1.2.max.
function high(p: Partial): bigint {
  switch (p.given) {
    case 0:
      return versionMax;
    case 1:
      return enc(p.major + 1n, 0n, 0n) - 1n;
    case 2:
      return enc(p.major, p.minor + 1n, 0n) - 1n;
  }
  return low(p);
}

// parseInt64 is strconv.ParseInt(s, 10, 64) for the short parts read here:
// an optional sign and decimal digits.
function parseDecimal(s: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  return BigInt(s);
}

function parsePartial(s0: string): Partial | null {
  let s = s0.startsWith("v") ? s0.slice(1) : s0;
  if (s.startsWith("=")) s = s.slice(1);
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  const parts = s.split(".");
  if (parts.length === 0 || parts.length > 3 || s === "") return null;
  const p: Partial = { major: 0n, minor: 0n, patch: 0n, given: 0 };
  const keys = ["major", "minor", "patch"] as const;
  let wild = false;
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? "";
    if (i === 2) {
      // A prerelease tag on the patch: 1.2.3-beta.1 is read as 1.2.3.
      const j = part.indexOf("-");
      if (j >= 0) part = part.slice(0, j);
    }
    if (part === "x" || part === "X" || part === "*") {
      wild = true;
      continue;
    }
    if (wild || part === "" || Buffer.byteLength(part, "utf8") > 5) return null;
    const n = parseDecimal(part);
    if (n === null || n < 0n || n > componentMax) return null;
    p[keys[i] ?? "patch"] = n;
    p.given = i + 1;
  }
  return p;
}

function parseComparator(tok0: string): Interval | null {
  const all: Interval = { lo: 0n, hi: versionMax };
  let op = "";
  let tok = tok0;
  for (const o of [">=", "<=", "~>", ">", "<", "=", "^", "~"]) {
    if (tok.startsWith(o)) {
      op = o;
      tok = tok.slice(o.length);
      break;
    }
  }
  const p = parsePartial(tok);
  if (!p) return null;
  switch (op) {
    case "":
    case "=":
      return { lo: low(p), hi: high(p) };
    case ">":
      if (p.given === 0) return { lo: 1n, hi: 0n }; // nothing is above *
      return { lo: high(p) + 1n, hi: versionMax };
    case ">=":
      return { lo: low(p), hi: versionMax };
    case "<":
      if (p.given === 0) return { lo: 1n, hi: 0n };
      return { lo: 0n, hi: low(p) - 1n };
    case "<=":
      return { lo: 0n, hi: high(p) };
    case "~":
    case "~>":
      switch (p.given) {
        case 0:
          return all;
        case 1:
          return { lo: low(p), hi: enc(p.major + 1n, 0n, 0n) - 1n };
      }
      return { lo: low(p), hi: enc(p.major, p.minor + 1n, 0n) - 1n };
    case "^":
      if (p.given === 0) return all;
      if (p.major > 0n || p.given === 1) {
        return { lo: low(p), hi: enc(p.major + 1n, 0n, 0n) - 1n };
      }
      if (p.minor > 0n || p.given === 2) {
        return { lo: low(p), hi: enc(p.major, p.minor + 1n, 0n) - 1n };
      }
      return { lo: low(p), hi: enc(0n, 0n, p.patch + 1n) - 1n };
  }
  return null;
}
