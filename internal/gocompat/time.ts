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

/**
 * hours is Go's Duration.Hours: the whole hours plus the rest as a fraction,
 * computed on the integer nanoseconds as Go does (not ms / 3.6e6).
 */
export function hours(d: Duration): number {
  return Number(d / hour) + Number(d % hour) / 3.6e12;
}

/**
 * sub is Go's t.Sub(u) for two instants in Unix nanoseconds: the Duration
 * between them, saturated to the int64 range.
 */
export function sub(t: bigint, u: bigint): Duration {
  const d = t - u;
  if (d > two63 - 1n) return two63 - 1n;
  if (d < -two63) return -two63;
  return d;
}

// daysFromCivil counts the days from 1970-01-01 to a proleptic Gregorian
// date (Howard Hinnant's algorithm), for any year Go's parser accepts.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * parseRFC3339Nano is Go's time.Parse(time.RFC3339Nano, s) with the
 * nanoseconds kept: the instant in Unix nanoseconds, or undefined when Go
 * rejects the string. Go's RFC 3339 fast path is read here with nine digits
 * of fraction; a string it rejects goes to the general layout parser
 * (parseRFC3339 below, which keeps milliseconds only).
 */
export function parseRFC3339Nano(s: string): bigint | undefined {
  const fast = parseRFC3339Fast(s);
  if (fast !== undefined) {
    return fast;
  }
  try {
    return BigInt(parseRFC3339(s).getTime()) * millisecond;
  } catch {
    return undefined;
  }
}

function parseRFC3339Fast(s: string): bigint | undefined {
  // The fast path's shape: fixed digits and separators, a fraction only
  // when a digit follows the dot, then Z or a ±hh:mm offset.
  const m =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/.exec(
      s,
    );
  if (m === null) {
    return undefined;
  }
  const [year, month, day, hr, min, sec] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(month, year) ||
    hr > 23 ||
    min > 59 ||
    sec > 59
  ) {
    return undefined;
  }
  // Go reads nine digits of the fraction and ignores the rest.
  const nsec = BigInt((m[7] ?? "").slice(0, 9).padEnd(9, "0"));
  let offset = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) {
      return undefined;
    }
    offset = (oh * 60 + om) * 60 * (m[8] === "-" ? -1 : 1);
  }
  const secs =
    BigInt(daysFromCivil(year, month, day)) * 86400n +
    BigInt(hr * 3600 + min * 60 + sec - offset);
  return secs * second + nsec;
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

// RFC3339 is Go's time.RFC3339 layout.
const RFC3339 = "2006-01-02T15:04:05Z07:00";

// The chunks of the RFC 3339 layout as Go's nextStdChunk splits it: the
// literal prefix, then the element.
const rfc3339Chunks = [
  ["", "2006"],
  ["-", "01"],
  ["-", "02"],
  ["T", "15"],
  [":", "04"],
  [":", "05"],
  ["", "Z07:00"],
] as const;

// parseError is the text of Go's *time.ParseError.
function parseError(
  value: string,
  layoutElem: string,
  valueElem: string,
  message: string,
): Error {
  if (message !== "") {
    return new Error(`parsing time ${timeQuote(value)}${message}`);
  }
  return new Error(
    `parsing time ${timeQuote(value)} as ${timeQuote(RFC3339)}: cannot parse ${timeQuote(valueElem)} as ${timeQuote(layoutElem)}`,
  );
}

// getnum is the time package's getnum: one or two leading digits, exactly
// two when fixed. undefined where Go returns errBad.
function getnum(s: string, fixed: boolean): [number, string] | undefined {
  if (!isDigit(s.charAt(0))) {
    return undefined;
  }
  if (!isDigit(s.charAt(1))) {
    return fixed ? undefined : [Number(s.charAt(0)), s.slice(1)];
  }
  return [Number(s.slice(0, 2)), s.slice(2)];
}

function daysIn(month: number, year: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * parseRFC3339 is Go's time.Parse(time.RFC3339, s), which is how Go 1.27's
 * json.Unmarshal reads a time.Time: more lenient than RFC 3339 (a one-digit
 * hour, a comma before the fraction, offsets up to 24:60). It throws an Error
 * with the text of Go's *time.ParseError. The Date keeps milliseconds only.
 */
export function parseRFC3339(s: string): Date {
  // The time package works on bytes; a byte string keeps the offsets right.
  const avalue = Buffer.from(s, "utf8").toString("latin1");
  const fail = (layoutElem: string, valueElem: string, message: string) =>
    parseError(fromLatin1(avalue), layoutElem, fromLatin1(valueElem), message);
  let value = avalue;
  let year = 0;
  let month = -1;
  let day = -1;
  let hour = 0;
  let min = 0;
  let sec = 0;
  let nsec = 0;
  let zoneOffset = 0;
  for (const [prefix, std] of rfc3339Chunks) {
    if (prefix !== "") {
      if (!value.startsWith(prefix)) {
        throw fail(prefix, value, "");
      }
      value = value.slice(1);
    }
    const hold = value;
    let bad = false;
    let rangeErr = "";
    switch (std) {
      case "2006": {
        const p = value.slice(0, 4);
        if (
          value.length < 4 ||
          !isDigit(value.charAt(0)) ||
          !/^[+-]?[0-9]*$/.test(p)
        ) {
          bad = true;
          break;
        }
        year = Number(p);
        value = value.slice(4);
        break;
      }
      case "01": {
        const r = getnum(value, true);
        if (r === undefined) {
          bad = true;
          break;
        }
        [month, value] = r;
        if (month <= 0 || month > 12) rangeErr = "month";
        break;
      }
      case "02": {
        const r = getnum(value, true);
        if (r === undefined) {
          bad = true;
          break;
        }
        [day, value] = r;
        break;
      }
      case "15": {
        const r = getnum(value, false);
        if (r === undefined) {
          bad = true;
          break;
        }
        [hour, value] = r;
        if (hour >= 24) rangeErr = "hour";
        break;
      }
      case "04": {
        const r = getnum(value, true);
        if (r === undefined) {
          bad = true;
          break;
        }
        [min, value] = r;
        if (min >= 60) rangeErr = "minute";
        break;
      }
      case "05": {
        const r = getnum(value, true);
        if (r === undefined) {
          bad = true;
          break;
        }
        [sec, value] = r;
        if (sec >= 60) {
          rangeErr = "second";
          break;
        }
        // A fraction the layout does not name is read anyway.
        if (/^[.,][0-9]/.test(value)) {
          let n = 2;
          while (n < value.length && isDigit(value.charAt(n))) n++;
          const digits = value.slice(1, Math.min(n, 10));
          nsec = Number(digits.padEnd(9, "0"));
          value = value.slice(n);
        }
        break;
      }
      case "Z07:00": {
        if (value.startsWith("Z")) {
          value = value.slice(1);
          break;
        }
        if (value.length < 6 || value.charAt(3) !== ":") {
          bad = true;
          break;
        }
        const sign = value.charAt(0);
        const hr = getnum(value.slice(1, 3), true);
        const mm = hr && getnum(value.slice(4, 6), true);
        value = value.slice(6);
        if (hr === undefined || mm === undefined) {
          bad = true;
          break;
        }
        if (hr[0] > 24) rangeErr = "time zone offset hour";
        if (mm[0] > 60) rangeErr = "time zone offset minute";
        zoneOffset = (hr[0] * 60 + mm[0]) * 60;
        if (sign === "-") zoneOffset = -zoneOffset;
        else if (sign !== "+") bad = true;
        break;
      }
    }
    if (rangeErr !== "") {
      throw fail(std, value, `: ${rangeErr} out of range`);
    }
    if (bad) {
      throw fail(std, hold, "");
    }
  }
  if (value.length !== 0) {
    throw fail("", value, `: extra text: ${timeQuote(fromLatin1(value))}`);
  }
  if (day < 1 || day > daysIn(month, year)) {
    throw fail("", value, ": day out of range");
  }
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  t.setUTCHours(hour, min, sec, Math.floor(nsec / 1e6));
  return new Date(t.getTime() - zoneOffset * 1000);
}

// fromLatin1 turns a byte string back into text.
function fromLatin1(b: string): string {
  return Buffer.from(b, "latin1").toString("utf8");
}
