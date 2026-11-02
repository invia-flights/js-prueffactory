// Go's strconv quoting (Quote, QuoteRune, IsPrint) for the texts that Go
// writes into error messages.
import { decodeRune, RuneError } from "./utf8.ts";

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

// isPrint reports whether r is printable as strconv.IsPrint defines it:
// letters, marks, numbers, punctuation, symbols and the ASCII space.
// Characters that Node's Unicode version knows and Go's does not may differ.
export function isPrint(r: number): boolean {
  if (r <= 0xff) {
    return (r >= 0x20 && r <= 0x7e) || (r >= 0xa1 && r <= 0xff && r !== 0xad);
  }
  if (r >= 0xd800 && r <= 0xdfff) return false;
  return printable.test(String.fromCodePoint(r));
}

// quoteRune is strconv.QuoteRune.
export function quoteRune(r: number): string {
  if (r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff)) r = RuneError;
  return "'" + escapedRune(r, "'") + "'";
}

// quote is strconv.Quote applied to a byte string: invalid UTF-8 bytes come
// out as \x escapes.
export function quote(b: Uint8Array): string {
  let out = '"';
  for (let i = 0; i < b.length;) {
    const [r, size] = decodeRune(b, i);
    if (r === RuneError && size === 1) {
      out += "\\x" + hex(b[i] ?? 0, 2);
      i++;
      continue;
    }
    out += escapedRune(r, '"');
    i += size;
  }
  return out + '"';
}

function escapedRune(r: number, q: string): string {
  const ch = String.fromCodePoint(r);
  if (ch === q || ch === "\\") return "\\" + ch;
  if (isPrint(r)) return ch;
  switch (r) {
    case 0x07:
      return "\\a";
    case 0x08:
      return "\\b";
    case 0x0c:
      return "\\f";
    case 0x0a:
      return "\\n";
    case 0x0d:
      return "\\r";
    case 0x09:
      return "\\t";
    case 0x0b:
      return "\\v";
  }
  if (r < 0x20 || r === 0x7f) return "\\x" + hex(r, 2);
  if (r < 0x10000) return "\\u" + hex(r, 4);
  return "\\U" + hex(r, 8);
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}
