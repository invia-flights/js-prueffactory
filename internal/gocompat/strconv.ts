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
