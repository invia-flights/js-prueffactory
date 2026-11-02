// Go's fmt verbs that reach messages users read: %q and the float verbs.
// JSON.stringify is not %q, and toFixed is not %.Nf (it rounds a tie up, Go
// rounds it to even).

import { isPrint } from "./strings.ts";

const hex = "0123456789abcdef";

function hexDigits(n: number, width: number): string {
  let out = "";
  for (let i = width - 1; i >= 0; i--) {
    out += hex.charAt(Math.floor(n / 16 ** i) % 16);
  }
  return out;
}

/**
 * quote is Go's strconv.Quote, which `%q` prints: a double-quoted string with
 * Go escapes. Printable characters stay as they are; others become \a, \b,
 * \f, \n, \r, \t, \v, \xNN below U+0020 and for DEL, \uNNNN or \UNNNNNNNN.
 */
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    let c = ch.codePointAt(0) ?? 0xfffd;
    if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd; // a lone surrogate is written as U+FFFD
    }
    if (c === 0x22 || c === 0x5c) {
      out += "\\" + String.fromCharCode(c);
      continue;
    }
    if (isPrint(c)) {
      out += String.fromCodePoint(c);
      continue;
    }
    switch (c) {
      case 0x07:
        out += "\\a";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0b:
        out += "\\v";
        break;
      default:
        if (c < 0x20 || c === 0x7f) {
          out += "\\x" + hexDigits(c, 2);
        } else if (c < 0x10000) {
          out += "\\u" + hexDigits(c, 4);
        } else {
          out += "\\U" + hexDigits(c, 8);
        }
    }
  }
  return out + '"';
}

/**
 * formatFloatV is Go's `%v` of a float64: the shortest digits that read back
 * as the same number, in exponent form when the exponent is below -4 or at
 * least 6, with at least two exponent digits (`1e-07`, `1.234567e+06`).
 */
export function formatFloatV(x: number): string {
  if (Number.isNaN(x)) {
    return "NaN";
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? "+Inf" : "-Inf";
  }
  if (x === 0) {
    return Object.is(x, -0) ? "-0" : "0";
  }
  const [mantissa = "", exponent = "0"] = x.toExponential().split("e");
  const exp = Number(exponent);
  if (exp < -4 || exp >= 6) {
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${mantissa}e${exp < 0 ? "-" : "+"}${digits}`;
  }
  return String(x); // plain decimal with the shortest digits, as Go's %f with them
}

// decompose returns the integer mantissa and the binary exponent of a finite
// non-negative double: x = mantissa * 2^exponent exactly.
function decompose(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biased === 0) {
    return [fraction, -1074];
  }
  return [fraction | 0x10000000000000n, biased - 1075];
}

/**
 * formatFloatFixed is Go's `%.Nf`: the exact value of the double rounded to
 * prec decimals, a tie to the even digit, with the sign kept for negative zero.
 */
export function formatFloatFixed(x: number, prec: number): string {
  if (Number.isNaN(x)) {
    return "NaN";
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? "+Inf" : "-Inf";
  }
  const negative = x < 0 || Object.is(x, -0);
  const [mantissa, exponent] = decompose(Math.abs(x));
  const scale = 10n ** BigInt(prec);
  let scaled: bigint;
  if (exponent >= 0) {
    scaled = (mantissa << BigInt(exponent)) * scale;
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    scaled = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    if (twice > denominator || (twice === denominator && scaled % 2n === 1n)) {
      scaled += 1n;
    }
  }
  let digits = scaled.toString();
  if (prec > 0) {
    digits = digits.padStart(prec + 1, "0");
    digits = `${digits.slice(0, -prec)}.${digits.slice(-prec)}`;
  }
  return (negative ? "-" : "") + digits;
}
