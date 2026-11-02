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
