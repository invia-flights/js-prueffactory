// Scalar resolution of gopkg.in/yaml.v3 v3.0.1 (resolve.go): which plain
// scalars are null, bool, int, float or timestamp, with yaml.v3's own rules
// (YAML 1.1 octals such as 017, underscores, 0b and 0o prefixes, only
// true/false as booleans), and the Go types the values get.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Apache License 2.0, see LICENSE in this folder.
import { GoTime } from "./gotime.ts";
import { daysIn } from "../gocompat/time.ts";

export const nullTag = "!!null";
export const boolTag = "!!bool";
export const strTag = "!!str";
export const intTag = "!!int";
export const floatTag = "!!float";
export const timestampTag = "!!timestamp";
export const seqTag = "!!seq";
export const mapTag = "!!map";
export const binaryTag = "!!binary";
export const mergeTag = "!!merge";

const longTagPrefix = "tag:yaml.org,2002:";

export function shortTag(tag: string): string {
  if (tag.startsWith(longTagPrefix)) {
    return "!!" + tag.slice(longTagPrefix.length);
  }
  return tag;
}

export function longTag(tag: string): string {
  if (tag.startsWith("!!")) return longTagPrefix + tag.slice(2);
  return tag;
}

// GoUint64 is a uint64 value: an int above the int64 range. Go's int is a
// bigint; float64 is a number; time.Time is a GoTime.
export class GoUint64 {
  readonly value: bigint;
  constructor(value: bigint) {
    this.value = value;
  }
}

export type Resolved =
  null | boolean | string | number | bigint | GoUint64 | GoTime;

export class ResolveError extends Error {}

const resolveMap = new Map<string, [string, Resolved]>();
for (const [tag, value, list] of [
  [boolTag, true, ["true", "True", "TRUE"]],
  [boolTag, false, ["false", "False", "FALSE"]],
  [nullTag, null, ["", "~", "null", "Null", "NULL"]],
  [floatTag, NaN, [".nan", ".NaN", ".NAN"]],
  [floatTag, Infinity, [".inf", ".Inf", ".INF"]],
  [floatTag, Infinity, ["+.inf", "+.Inf", "+.INF"]],
  [floatTag, -Infinity, ["-.inf", "-.Inf", "-.INF"]],
  [mergeTag, "<<", ["<<"]],
] as const) {
  for (const s of list) resolveMap.set(s, [tag, value]);
}

function hintOf(c: string | undefined): string {
  if (c === undefined) return "N";
  if (c === "+" || c === "-") return "S";
  if (c >= "0" && c <= "9") return "D";
  if ("yYnNtTfFoO~".includes(c)) return "M";
  if (c === ".") return ".";
  return "";
}

function resolvableTag(tag: string): boolean {
  return (
    tag === "" ||
    tag === strTag ||
    tag === boolTag ||
    tag === intTag ||
    tag === floatTag ||
    tag === nullTag ||
    tag === timestampTag
  );
}

const yamlStyleFloat = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;
const uint64Max = 2n ** 64n - 1n;

// parseUint is strconv.ParseUint(s, base, 64) for the bases yaml.v3 uses;
// base 0 reads the 0b, 0o, 0x and 0 prefixes. Underscores were removed
// before.
function parseUint(s0: string, base0: number): bigint | null {
  let s = s0;
  let base = base0;
  if (s === "") return null;
  if (base === 0) {
    base = 10;
    if (s.startsWith("0")) {
      const p = s.length >= 3 ? (s[1] ?? "").toLowerCase() : "";
      if (p === "b") {
        base = 2;
        s = s.slice(2);
      } else if (p === "o") {
        base = 8;
        s = s.slice(2);
      } else if (p === "x") {
        base = 16;
        s = s.slice(2);
      } else {
        base = 8;
        s = s.slice(1);
      }
    }
  }
  let n = 0n;
  const b = BigInt(base);
  for (const c of s) {
    const d = digitValue(c);
    if (d < 0 || d >= base) return null;
    n = n * b + BigInt(d);
    if (n > uint64Max) return null;
  }
  return n;
}

function digitValue(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  const l = c.toLowerCase();
  if (l >= "a" && l <= "z") return l.charCodeAt(0) - 97 + 10;
  return -1;
}

// parseInt is strconv.ParseInt(s, base, 64).
function parseInt64(s: string, base: number): bigint | null {
  if (s === "") return null;
  let neg = false;
  let rest = s;
  if (s.startsWith("+") || s.startsWith("-")) {
    neg = s.startsWith("-");
    rest = s.slice(1);
  }
  const un = parseUint(rest, base);
  if (un === null) return null;
  const v = neg ? -un : un;
  if (v < int64Min || v > int64Max) return null;
  return v;
}

// parseFloatDot is strconv.ParseFloat for a scalar that starts with '.',
// which is all resolve hands it there: digits with underscores between
// them, an optional exponent; a value out of range is an error.
function parseFloatDot(s: string): number | null {
  if (!/^\.[0-9_]+([eE][-+]?[0-9_]+)?$/.test(s)) return null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "_") continue;
    const before = s[i - 1] ?? "";
    const after = s[i + 1] ?? "";
    if (!/[0-9]/.test(before) || !/[0-9]/.test(after)) return null;
  }
  const v = Number(s.replaceAll("_", ""));
  if (!Number.isFinite(v)) return null;
  return v;
}

function intValue(v: bigint): bigint {
  return v;
}

// resolve is yaml.v3's resolve(tag, in): the resolved tag and value. It
// throws a ResolveError with yaml.v3's text when an explicit tag does not
// fit the text.
export function resolve(tag0: string, input: string): [string, Resolved] {
  const tag = shortTag(tag0);
  if (!resolvableTag(tag)) return [tag, input];
  const [rtag, out] = resolveInner(tag, input);
  if (tag === "" || tag === rtag || tag === strTag || tag === binaryTag) {
    return [rtag, out];
  }
  if (tag === floatTag && rtag === intTag && typeof out === "bigint") {
    return [floatTag, Number(out)];
  }
  throw new ResolveError(
    `cannot decode ${shortTag(rtag)} \`${input}\` as a ${shortTag(tag)}`,
  );
}

function resolveInner(tag: string, input: string): [string, Resolved] {
  const hint = hintOf(input === "" ? undefined : input[0]);
  if (hint !== "" && tag !== strTag && tag !== binaryTag) {
    const item = resolveMap.get(input);
    if (item) return item;
    switch (hint) {
      case "M":
        break;
      case ".": {
        const f = parseFloatDot(input);
        if (f !== null) return [floatTag, f];
        break;
      }
      case "D":
      case "S": {
        if (tag === "" || tag === timestampTag) {
          const t = parseTimestamp(input);
          if (t) return [timestampTag, t];
        }
        const plain = input.replaceAll("_", "");
        const intv = parseInt64(plain, 0);
        if (intv !== null) return [intTag, intValue(intv)];
        const uintv = parseUint(plain, 0);
        if (uintv !== null) return [intTag, new GoUint64(uintv)];
        if (yamlStyleFloat.test(plain)) {
          const f = Number(plain);
          if (Number.isFinite(f)) return [floatTag, f];
        }
        if (plain.startsWith("0b")) {
          const i = parseInt64(plain.slice(2), 2);
          if (i !== null) return [intTag, intValue(i)];
          const u = parseUint(plain.slice(2), 2);
          if (u !== null) return [intTag, new GoUint64(u)];
        } else if (plain.startsWith("-0b")) {
          const i = parseInt64("-" + plain.slice(3), 2);
          if (i !== null) return [intTag, intValue(i)];
        }
        if (plain.startsWith("0o")) {
          const i = parseInt64(plain.slice(2), 8);
          if (i !== null) return [intTag, intValue(i)];
          const u = parseUint(plain.slice(2), 8);
          if (u !== null) return [intTag, new GoUint64(u)];
        } else if (plain.startsWith("-0o")) {
          const i = parseInt64("-" + plain.slice(3), 8);
          if (i !== null) return [intTag, intValue(i)];
        }
        break;
      }
    }
  }
  return [strTag, input];
}

// parseTimestamp accepts the four layouts yaml.v3 tries with time.Parse:
// "2006-1-2T15:4:5.999999999Z07:00", the same with a lower-case t,
// "2006-1-2 15:4:5.999999999" and "2006-1-2".
export function parseTimestamp(s: string): GoTime | null {
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c < "0" || c > "9") break;
  }
  if (i !== 4 || i === s.length || s[i] !== "-") return null;
  return (
    parseLayout(s, "T", true) ??
    parseLayout(s, "t", true) ??
    parseLayout(s, " ", false) ??
    parseDateOnly(s)
  );
}

// A cursor over the text, as time.Parse consumes it.
class Cursor {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  // getnum reads one or two digits (time.getnum with fixed=false).
  num(): number | null {
    const a = this.s[0];
    if (a === undefined || a < "0" || a > "9") return null;
    const b = this.s[1];
    if (b === undefined || b < "0" || b > "9") {
      this.s = this.s.slice(1);
      return Number(a);
    }
    this.s = this.s.slice(2);
    return Number(a) * 10 + Number(b);
  }
  lit(t: string): boolean {
    if (!this.s.startsWith(t)) return false;
    this.s = this.s.slice(t.length);
    return true;
  }
}

function parseDate(c: Cursor): [number, number, number] | null {
  if (c.s.length < 4) return null;
  const y = c.s.slice(0, 4);
  if (!/^[0-9]{4}$/.test(y)) return null;
  c.s = c.s.slice(4);
  if (!c.lit("-")) return null;
  const month = c.num();
  if (month === null || month < 1 || month > 12) return null;
  if (!c.lit("-")) return null;
  const day = c.num();
  if (day === null) return null;
  return [Number(y), month, day];
}

function parseDateOnly(s: string): GoTime | null {
  const c = new Cursor(s);
  const d = parseDate(c);
  if (!d || c.s !== "") return null;
  const [y, mo, day] = d;
  if (day < 1 || day > daysIn(mo, y)) return null;
  return new GoTime(y, mo, day, 0, 0, 0, 0, null);
}

function parseLayout(s: string, sep: string, zone: boolean): GoTime | null {
  const c = new Cursor(s);
  const d = parseDate(c);
  if (!d) return null;
  const [y, mo, day] = d;
  if (!c.lit(sep)) return null;
  const hour = c.num();
  if (hour === null || hour >= 24) return null;
  if (!c.lit(":")) return null;
  const min = c.num();
  if (min === null || min >= 60) return null;
  if (!c.lit(":")) return null;
  const sec = c.num();
  if (sec === null || sec >= 60) return null;
  let nsec = 0;
  // .999999999: an optional fraction after a period or comma.
  const f = /^[.,]([0-9]+)/.exec(c.s);
  if (f?.[1] !== undefined) {
    const digits = f[1].slice(0, 9).padEnd(9, "0");
    nsec = Number(digits);
    c.s = c.s.slice(f[0].length);
  }
  let offset: number | null = null;
  if (zone) {
    if (c.lit("Z")) {
      offset = null;
    } else {
      const z = /^([+-])([0-9]{2}):([0-9]{2})/.exec(c.s);
      if (!z) return null;
      const hh = Number(z[2]);
      const mm = Number(z[3]);
      if (hh > 24 || mm > 60) return null;
      offset = (hh * 3600 + mm * 60) * (z[1] === "-" ? -1 : 1);
      c.s = c.s.slice(6);
    }
  }
  if (c.s !== "") return null;
  if (day < 1 || day > daysIn(mo, y)) return null;
  // An offset of zero is the UTC location when the local zone is UTC; the
  // Go build ran with whatever zone the host had (see traps.md).
  if (offset === 0) offset = null;
  return new GoTime(y, mo, day, hour, min, sec, nsec, offset);
}
