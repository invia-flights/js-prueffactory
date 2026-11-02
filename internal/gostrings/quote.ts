// Go's strconv.Quote, which fmt's %q verb prints for a string: a double-quoted
// string with Go escapes. Printable runes, non-ASCII ones included, stay as
// they are; the rest become \a \b \f \n \r \t \v, \xHH below U+0020 and for
// U+007F, \uHHHH or \UHHHHHHHH. Error messages that Go formats with %q use it.
// A lone surrogate, which a Go string cannot hold, prints as �.

const named: Readonly<Record<string, string>> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
  '"': '\\"',
  "\\": "\\\\",
};

// strconv.IsPrint: letters, marks, numbers, punctuation, symbols and the ASCII
// space. Other spaces (U+00A0, U+2000 …) and format characters are escaped.
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = named[ch];
    if (esc !== undefined) {
      out += esc;
      continue;
    }
    const r = ch.codePointAt(0) ?? 0;
    if (r >= 0xd800 && r <= 0xdfff) {
      out += "\\ufffd";
    } else if (r < 0x20 || r === 0x7f) {
      out += "\\x" + hex(r, 2);
    } else if (printable.test(ch)) {
      out += ch;
    } else if (r < 0x10000) {
      out += "\\u" + hex(r, 4);
    } else {
      out += "\\U" + hex(r, 8);
    }
  }
  return out + '"';
}
