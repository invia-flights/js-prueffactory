// Go's time.Duration: an int64 count of nanoseconds, here a bigint so that
// every Go value and Go's overflow rules survive. time.ParseDuration reads what
// users pass to --budget; Duration.String is every %s of a Duration.

/** A Go time.Duration: nanoseconds, always within the int64 range. */
export type Duration = bigint;

export const nanosecond: Duration = 1n;
export const microsecond: Duration = 1000n * nanosecond;
export const millisecond: Duration = 1000n * microsecond;
export const second: Duration = 1000n * millisecond;
export const minute: Duration = 60n * second;
export const hour: Duration = 60n * minute;

const two63 = 1n << 63n;

/** wrapInt64 is Go's int64 arithmetic: the value modulo 2^64, signed. */
export function wrapInt64(x: bigint): bigint {
  return BigInt.asIntN(64, x);
}

const unitMap = new Map<string, bigint>([
  ["ns", nanosecond],
  ["us", microsecond],
  ["µs", microsecond], // micro sign
  ["μs", microsecond], // Greek letter mu
  ["ms", millisecond],
  ["s", second],
  ["m", minute],
  ["h", hour],
]);

const lowerHex = "0123456789abcdef";

// timeQuote is the time package's own quote, not strconv.Quote: every byte of
// a non-ASCII or control character is written as \xNN.
function timeQuote(s: string): string {
  let out = '"';
  for (const b of Buffer.from(s, "utf8")) {
    if (b >= 0x80 || b < 0x20) {
      out += "\\x" + lowerHex.charAt(b >> 4) + lowerHex.charAt(b & 0xf);
      continue;
    }
    if (b === 0x22 || b === 0x5c) {
      out += "\\";
    }
    out += String.fromCharCode(b);
  }
  return out + '"';
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * parseDuration is Go's time.ParseDuration: `[-+]?([0-9]*(\.[0-9]*)?[a-z]+)+`
 * with the units ns, us, µs, μs, ms, s, m and h, or "0" alone. It throws an
 * Error with Go's message on invalid input.
 */
export function parseDuration(orig: string): Duration {
  const invalid = (): Error =>
    new Error("time: invalid duration " + timeQuote(orig));
  let s = orig;
  let neg = false;
  if (s !== "" && (s.startsWith("-") || s.startsWith("+"))) {
    neg = s.startsWith("-");
    s = s.slice(1);
  }
  if (s === "0") {
    return 0n;
  }
  if (s === "") {
    throw invalid();
  }
  let d = 0n;
  while (s !== "") {
    const first = s.charAt(0);
    if (!(first === "." || isDigit(first))) {
      throw invalid();
    }
    // leading integer
    let v = 0n;
    let i = 0;
    for (; i < s.length && isDigit(s.charAt(i)); i++) {
      if (v > two63 / 10n) {
        throw invalid();
      }
      v = v * 10n + BigInt(s.charCodeAt(i) - 0x30);
      if (v > two63) {
        throw invalid();
      }
    }
    const pre = i > 0;
    s = s.slice(i);

    // fraction
    let f = 0n;
    let scale = 1;
    let post = false;
    if (s.startsWith(".")) {
      s = s.slice(1);
      let overflow = false;
      let j = 0;
      for (; j < s.length && isDigit(s.charAt(j)); j++) {
        if (overflow) {
          continue;
        }
        if (f > (two63 - 1n) / 10n) {
          overflow = true;
          continue;
        }
        const y = f * 10n + BigInt(s.charCodeAt(j) - 0x30);
        if (y > two63) {
          overflow = true;
          continue;
        }
        f = y;
        scale *= 10;
      }
      post = j > 0;
      s = s.slice(j);
    }
    if (!pre && !post) {
      throw invalid();
    }

    // unit
    let u = 0;
    for (; u < s.length; u++) {
      const c = s.charAt(u);
      if (c === "." || isDigit(c)) {
        break;
      }
    }
    if (u === 0) {
      throw new Error("time: missing unit in duration " + timeQuote(orig));
    }
    const name = s.slice(0, u);
    s = s.slice(u);
    const unit = unitMap.get(name);
    if (unit === undefined) {
      throw new Error(
        "time: unknown unit " +
          timeQuote(name) +
          " in duration " +
          timeQuote(orig),
      );
    }
    if (v > two63 / unit) {
      throw invalid();
    }
    v *= unit;
    if (f > 0n) {
      // Go computes this in float64: uint64(float64(f) * (float64(unit) / scale)).
      v += BigInt(Math.trunc(Number(f) * (Number(unit) / scale)));
      if (v > two63) {
        throw invalid();
      }
    }
    d += v;
    if (d > two63) {
      throw invalid();
    }
  }
  if (neg) {
    return wrapInt64(-d);
  }
  if (d > two63 - 1n) {
    throw invalid();
  }
  return d;
}

// fmtFrac writes the fraction of v/10**prec without trailing zeros (and
// without the point when it is zero) and returns it with v/10**prec.
function fmtFrac(v: bigint, prec: number): [string, bigint] {
  let out = "";
  let print = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10n;
    print ||= digit !== 0n;
    if (print) {
      out = String(digit) + out;
    }
    v /= 10n;
  }
  return [print ? "." + out : "", v];
}

/** durationString is Go's Duration.String: 1h30m0s, 1.5s, 500ms, 0s. */
export function durationString(d: Duration): string {
  const neg = d < 0n;
  let u = neg ? -d : d; // as uint64: -MinInt64 is 2^63, which bigint keeps
  let out: string;
  if (u < second) {
    let prec: number;
    let unit: string;
    if (u === 0n) {
      return "0s";
    } else if (u < microsecond) {
      prec = 0;
      unit = "ns";
    } else if (u < millisecond) {
      prec = 3;
      unit = "µs";
    } else {
      prec = 6;
      unit = "ms";
    }
    const [frac, rest] = fmtFrac(u, prec);
    out = String(rest) + frac + unit;
  } else {
    const [frac, secs] = fmtFrac(u, 9);
    u = secs;
    out = String(u % 60n) + frac + "s";
    u /= 60n;
    if (u > 0n) {
      out = String(u % 60n) + "m" + out;
      u /= 60n;
      if (u > 0n) {
        out = String(u) + "h" + out;
      }
    }
  }
  return neg ? "-" + out : out;
}

/** milliseconds converts a Duration to whole milliseconds, truncated. */
export function milliseconds(d: Duration): number {
  return Number(d / millisecond);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** formatCompactUTC is Go's t.UTC().Format("20060102T150405Z"). */
export function formatCompactUTC(t: Date): string {
  return (
    pad(t.getUTCFullYear(), 4) +
    pad(t.getUTCMonth() + 1, 2) +
    pad(t.getUTCDate(), 2) +
    "T" +
    pad(t.getUTCHours(), 2) +
    pad(t.getUTCMinutes(), 2) +
    pad(t.getUTCSeconds(), 2) +
    "Z"
  );
}
