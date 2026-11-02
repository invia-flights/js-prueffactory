// Strings as the Go build sees them: UTF-8 bytes. A JavaScript string is UTF-16,
// so its length, its `<` and its default sort differ from Go's wherever a text
// leaves ASCII. Every port module that measures, cuts or sorts text the Go
// code measured, cut or sorted uses these helpers.
//
// A lone surrogate cannot occur in Go text; Buffer and TextEncoder write it as
// U+FFFD, so it counts as U+FFFD here too.

const replacement = 0xfffd;

// codePointAt returns the code point that starts at unit i, with a lone
// surrogate read as U+FFFD.
function codePointAt(s: string, i: number): number {
  const c = s.codePointAt(i) ?? replacement;
  return c >= 0xd800 && c <= 0xdfff ? replacement : c;
}

/**
 * compareBytes orders two strings as Go's `<` does: by their UTF-8 bytes, which
 * is code point order. JavaScript's `<` and default sort compare UTF-16 units
 * and put U+10000 and above before U+E000 to U+FFFF.
 */
export function compareBytes(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(j);
    if (x < 0xd800 && y < 0xd800) {
      if (x !== y) {
        return x < y ? -1 : 1;
      }
      i++;
      j++;
      continue;
    }
    const cx = codePointAt(a, i);
    const cy = codePointAt(b, j);
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
    i += cx > 0xffff ? 2 : 1;
    j += cy > 0xffff ? 2 : 1;
  }
  if (i < a.length) {
    return 1;
  }
  return j < b.length ? -1 : 0;
}

/** byteLess is Go's `a < b` on strings. */
export function byteLess(a: string, b: string): boolean {
  return compareBytes(a, b) < 0;
}

/** sortStrings sorts in place as Go's sort.Strings does, and returns the list. */
export function sortStrings(list: string[]): string[] {
  return list.sort(compareBytes);
}

/** utf8Length is Go's len(s): the number of UTF-8 bytes. */
export function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** utf8Bytes returns the UTF-8 bytes of a string, as Go's []byte(s). */
export function utf8Bytes(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function utf8Width(c: number): number {
  if (c < 0x80) {
    return 1;
  }
  if (c < 0x800) {
    return 2;
  }
  return c < 0x10000 ? 3 : 4;
}

/**
 * cutUTF8 returns the longest prefix of s that has at most maxBytes UTF-8
 * bytes and ends on a character boundary, as Go code does when it cuts at
 * maxBytes and steps back to a rune start.
 */
export function cutUTF8(s: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const c = codePointAt(s, i);
    const w = utf8Width(c);
    if (bytes + w > maxBytes) {
      return s.slice(0, i);
    }
    bytes += w;
    i += c > 0xffff ? 2 : 1;
  }
  return s;
}

/** isSpace is Go's unicode.IsSpace. JavaScript's \s lacks U+0085 and adds U+FEFF. */
export function isSpace(c: number): boolean {
  if (c <= 0xff) {
    return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0;
  }
  return (
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** isControl is Go's unicode.IsControl: C0, DEL and C1. */
export function isControl(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
}

const graphic = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/**
 * isPrint is Go's strconv.IsPrint: letters, marks, numbers, punctuation,
 * symbols and the ASCII space. Node's Unicode tables may be newer than Go's,
 * so a character assigned in between counts as printable here only.
 */
export function isPrint(c: number): boolean {
  if (c === 0x20) {
    return true;
  }
  if (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0xd800 && c <= 0xdfff) ||
    c > 0x10ffff
  ) {
    return false;
  }
  return graphic.test(String.fromCodePoint(c));
}

/** fields is Go's strings.Fields: the runs of text between Go white space. */
export function fields(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  let i = 0;
  while (i < s.length) {
    const c = codePointAt(s, i);
    const width = c > 0xffff ? 2 : 1;
    if (isSpace(c)) {
      if (start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
    i += width;
  }
  if (start >= 0) {
    out.push(s.slice(start));
  }
  return out;
}

/** trimSpace is Go's strings.TrimSpace. JavaScript's trim() differs on U+0085 and U+FEFF. */
export function trimSpace(s: string): string {
  let start = 0;
  while (start < s.length && isSpace(s.charCodeAt(start))) {
    start++;
  }
  let end = s.length;
  while (end > start && isSpace(s.charCodeAt(end - 1))) {
    end--;
  }
  return s.slice(start, end);
}

// Go maps the case of each rune on its own, with the simple mappings of
// UnicodeData.txt. JavaScript applies the full mappings of SpecialCasing.txt,
// which can turn one character into several (U+0130 to "i" plus a combining
// dot, U+00DF to "SS", U+FB01 to "FI"). Where JavaScript's result has more than
// one code point, these give Go's simple mapping instead.

function simpleUpper(c: number): number {
  // Greek letters with ypogegrammeni: the simple upper case is the matching
  // letter with prosgegrammeni (U+1F80 to U+1F88 and so on).
  if (c >= 0x1f80 && c <= 0x1faf) {
    return c | 0x08;
  }
  switch (c) {
    case 0x1fb3:
      return 0x1fbc;
    case 0x1fc3:
      return 0x1fcc;
    case 0x1ff3:
      return 0x1ffc;
    default:
      return c; // no simple upper case: U+00DF, the ligatures, U+0149 ...
  }
}

function mapRunes(
  s: string,
  full: (ch: string) => string,
  simple: (c: number) => number,
): string {
  let out = "";
  for (const ch of s) {
    const c = codePointAt(ch, 0);
    if (c === replacement) {
      out += "\uFFFD"; // a lone surrogate, as Go's invalid UTF-8
      continue;
    }
    const mapped = full(ch);
    const first = mapped.codePointAt(0) ?? c;
    const single = mapped.length === (first > 0xffff ? 2 : 1);
    out += String.fromCodePoint(single ? first : simple(c));
  }
  return out;
}

/** toUpper is Go's strings.ToUpper: rune by rune, simple mappings only. */
export function toUpper(s: string): string {
  return mapRunes(s, (ch) => ch.toUpperCase(), simpleUpper);
}

/** toLower is Go's strings.ToLower: rune by rune, simple mappings only. */
export function toLower(s: string): string {
  // U+0130 is the only rune whose full lower case has several code points;
  // its simple lower case is "i".
  return mapRunes(
    s,
    (ch) => ch.toLowerCase(),
    (c) => (c === 0x130 ? 0x69 : c),
  );
}
