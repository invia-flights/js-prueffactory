// Go's strconv functions whose results or errors users see.

import { quote } from "./fmt.ts";

const maxInt64 = (1n << 63n) - 1n;

/**
 * parseInt64 is Go's strconv.ParseInt(s, 10, 64): an optional sign and ASCII
 * digits only. It throws an Error with Go's message ("strconv.ParseInt:
 * parsing "x": invalid syntax" or "...: value out of range").
 */
export function parseInt64(s: string): bigint {
  const fail = (why: string): Error =>
    new Error(`strconv.ParseInt: parsing ${quote(s)}: ${why}`);
  let digits = s;
  let neg = false;
  if (digits.startsWith("+") || digits.startsWith("-")) {
    neg = digits.startsWith("-");
    digits = digits.slice(1);
  }
  if (!/^[0-9]+$/.test(digits)) {
    throw fail("invalid syntax");
  }
  const v = BigInt(digits);
  if (neg ? v > maxInt64 + 1n : v > maxInt64) {
    throw fail("value out of range");
  }
  return neg ? -v : v;
}

/**
 * formatFloatF is Go's strconv.FormatFloat(x, 'f', -1, 64): the shortest
 * digits that read back as x, never in exponent form (1e21 is
 * "1000000000000000000000", 1e-7 is "0.0000001"); String(x) switches to an
 * exponent.
 */
export function formatFloatF(x: number): string {
  if (Number.isNaN(x)) {
    return "NaN";
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? "+Inf" : "-Inf";
  }
  if (x === 0) {
    return Object.is(x, -0) ? "-0" : "0";
  }
  const sign = x < 0 ? "-" : "";
  const [mantissa = "", exponent = "0"] = Math.abs(x)
    .toExponential()
    .split("e");
  const exp = Number(exponent);
  const digits = mantissa.replace(".", "");
  if (exp < 0) {
    return sign + "0." + "0".repeat(-exp - 1) + digits;
  }
  const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
  const frac = digits.slice(exp + 1);
  return sign + intPart + (frac === "" ? "" : "." + frac);
}

/**
 * atoi is Go's strconv.Atoi on a 64-bit platform: an optional sign and ASCII
 * digits within the int64 range. It returns undefined where Go returns an
 * error.
 */
export function atoi(s: string): bigint | undefined {
  try {
    return parseInt64(s);
  } catch {
    return undefined;
  }
}

/**
 * atoiClamped is strconv.Atoi of a run of ASCII digits with the error
 * ignored: a number that does not fit is the largest int64, which a
 * JavaScript number holds rounded up. Unlike atoiOrZero it never gives 0
 * for a large value.
 */
export function atoiClamped(digits: string): number {
  const max = (1n << 63n) - 1n;
  const n = BigInt(digits);
  return Number(n <= max ? n : max);
}

/**
 * atoiOrZero is strconv.Atoi with the error dropped, as a JavaScript number:
 * 0 for anything that is not a decimal integer, and for one beyond 2^53
 * (unlike atoiClamped, which clamps).
 */
export function atoiOrZero(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) {
    return 0;
  }
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * parseFloat is Go's strconv.ParseFloat(s, 64). It returns undefined where Go
 * returns an error: text that is no Go float literal over its whole length
 * (decimal, or hex with a p exponent; underscores between digits; "inf",
 * "infinity" and "nan" in any case) and a value that overflows to an
 * infinity. A value below the smallest one is zero, as in Go.
 */
export function parseFloat(s: string): number | undefined {
  const special = specialFloat(s);
  if (special !== undefined) {
    return special;
  }
  const r = readFloat(s);
  if (r === undefined) {
    return undefined;
  }
  let v: number;
  if (r.hex) {
    v = r.mantissa === 0n ? 0 : Number(r.mantissa) * 2 ** r.exp;
    if (!Number.isFinite(v) && r.exp < 0) {
      v = 0;
    }
  } else {
    v = Number(`${r.mantissa === 0n ? "0" : r.digits}e${String(r.exp)}`);
  }
  if (!Number.isFinite(v)) {
    return undefined;
  }
  return r.neg ? -v : v;
}

// specialFloat is Go's special over the whole string.
function specialFloat(s: string): number | undefined {
  let rest = s;
  let sign = 1;
  const signed = rest.startsWith("+") || rest.startsWith("-");
  if (signed) {
    sign = rest.startsWith("-") ? -1 : 1;
    rest = rest.slice(1);
  }
  const l = rest.toLowerCase();
  if (l === "inf" || l === "infinity") {
    return sign * Infinity;
  }
  if (!signed && l === "nan") {
    return NaN;
  }
  return undefined;
}

interface ReadFloat {
  neg: boolean;
  hex: boolean;
  // digits are the significant decimal digits (decimal only) and mantissa
  // their value; the number is digits * 10^exp, or mantissa * 2^exp for hex.
  digits: string;
  mantissa: bigint;
  exp: number;
}

// readFloat is Go's readFloat, required to consume all of s. It keeps every
// digit instead of the first 19, so the value is exact before rounding.
function readFloat(s: string): ReadFloat | undefined {
  let i = 0;
  let neg = false;
  let underscores = false;
  if (s[i] === "+" || s[i] === "-") {
    neg = s[i] === "-";
    i++;
  }
  let hex = false;
  if (
    i + 2 < s.length &&
    s[i] === "0" &&
    (s[i + 1] === "x" || s[i + 1] === "X")
  ) {
    hex = true;
    i += 2;
  }
  const base = hex ? 16n : 10n;
  let sawdot = false;
  let sawdigits = false;
  let nd = 0;
  let dp = 0;
  let digits = "";
  let mantissa = 0n;
  for (; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c === "_") {
      underscores = true;
      continue;
    }
    if (c === ".") {
      if (sawdot) break;
      sawdot = true;
      dp = nd;
      continue;
    }
    const v = digitValue(c, hex);
    if (v === undefined) break;
    sawdigits = true;
    if (v === 0 && nd === 0) {
      dp--;
      continue;
    }
    nd++;
    digits += c;
    mantissa = mantissa * base + BigInt(v);
  }
  if (!sawdigits) return undefined;
  if (!sawdot) dp = nd;
  if (hex) {
    dp *= 4;
  }
  const expChar = hex ? "p" : "e";
  let e = 0;
  if (i < s.length && (s[i] ?? "").toLowerCase() === expChar) {
    i++;
    if (i >= s.length) return undefined;
    let esign = 1;
    if (s[i] === "+") i++;
    else if (s[i] === "-") {
      i++;
      esign = -1;
    }
    if (i >= s.length || !/[0-9]/.test(s[i] ?? "")) return undefined;
    let n = 0;
    for (; i < s.length && /[0-9_]/.test(s[i] ?? ""); i++) {
      if (s[i] === "_") {
        underscores = true;
        continue;
      }
      if (n < 10000) n = n * 10 + Number(s[i]);
    }
    e = n * esign;
  } else if (hex) {
    return undefined;
  }
  if (i !== s.length) return undefined;
  if (underscores && !underscoreOK(s)) return undefined;
  // Leading zeros moved dp below zero; the value is digits * base^(dp-nd).
  const exp = hex ? dp + e - 4 * nd : dp + e - nd;
  return { neg, hex, digits, mantissa, exp };
}

function digitValue(c: string, hex: boolean): number | undefined {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 0x30;
  if (hex) {
    const l = c.toLowerCase();
    if (l >= "a" && l <= "f") return l.charCodeAt(0) - 0x61 + 10;
  }
  return undefined;
}

// underscoreOK is Go's underscoreOK: an underscore only between digits or
// after a base prefix.
function underscoreOK(s: string): boolean {
  let saw = "^";
  let i = 0;
  if (s.startsWith("-") || s.startsWith("+")) {
    s = s.slice(1);
  }
  let hex = false;
  if (s.length >= 2 && s.startsWith("0") && "bBoOxX".includes(s.charAt(1))) {
    i = 2;
    saw = "0";
    hex = s[1] === "x" || s[1] === "X";
  }
  for (; i < s.length; i++) {
    const c = s[i] ?? "";
    if (digitValue(c, hex) !== undefined) {
      saw = "0";
      continue;
    }
    if (c === "_") {
      if (saw !== "0") {
        return false;
      }
      saw = "_";
      continue;
    }
    if (saw === "_") {
      return false;
    }
    saw = "!";
  }
  return saw !== "_";
}
