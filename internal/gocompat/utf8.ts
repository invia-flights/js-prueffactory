// UTF-8 handling as Go's unicode/utf8 and bytes packages do it. Go keeps
// strings as bytes and replaces each invalid byte with U+FFFD only when it
// decodes them; TextDecoder replaces a maximal invalid subpart with one
// U+FFFD instead, so it cannot stand in for Go.

import { isSpace } from "./strings.ts";

export const RuneError = 0xfffd;

// decodeRune returns the rune at b[i] and its width in bytes, as
// utf8.DecodeRune: an invalid or truncated sequence is (RuneError, 1), and
// an empty input is (RuneError, 0).
export function decodeRune(b: Uint8Array, i = 0): [rune: number, size: number] {
  const n = b.length - i;
  if (n < 1) return [RuneError, 0];
  const c0 = byteAt(b, i);
  if (c0 < 0x80) return [c0, 1];
  const [size, lo, hi] = leadInfo(c0);
  if (size === 1 || n < size) return [RuneError, 1];
  const c1 = byteAt(b, i + 1);
  if (c1 < lo || c1 > hi) return [RuneError, 1];
  if (size === 2) return [((c0 & 0x1f) << 6) | (c1 & 0x3f), 2];
  const c2 = byteAt(b, i + 2);
  if (c2 < 0x80 || c2 > 0xbf) return [RuneError, 1];
  if (size === 3) {
    return [((c0 & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f), 3];
  }
  const c3 = byteAt(b, i + 3);
  if (c3 < 0x80 || c3 > 0xbf) return [RuneError, 1];
  return [
    ((c0 & 0x07) << 18) |
      ((c1 & 0x3f) << 12) |
      ((c2 & 0x3f) << 6) |
      (c3 & 0x3f),
    4,
  ];
}

// fullRune reports whether b[i:] begins with a full UTF-8 encoding of a rune,
// as utf8.FullRune. An invalid encoding counts as full: it decodes as a
// one-byte error.
export function fullRune(b: Uint8Array, i = 0): boolean {
  const n = b.length - i;
  if (n < 1) return false;
  const c0 = byteAt(b, i);
  if (c0 < 0x80) return true;
  const [size, lo, hi] = leadInfo(c0);
  if (n >= size) return true;
  if (n > 1) {
    const c1 = byteAt(b, i + 1);
    if (c1 < lo || c1 > hi) return true;
  }
  if (n > 2) {
    const c2 = byteAt(b, i + 2);
    if (c2 < 0x80 || c2 > 0xbf) return true;
  }
  return false;
}

// goString turns bytes into a string the way Go's decoders see them: every
// byte that does not start a valid sequence becomes one U+FFFD.
export function goString(b: Uint8Array): string {
  let out = "";
  let start = 0;
  let i = 0;
  while (i < b.length) {
    if (byteAt(b, i) < 0x80) {
      i++;
      continue;
    }
    const [r, size] = decodeRune(b, i);
    if (r === RuneError && size === 1) {
      out += utf8Slice(b, start, i) + "\ufffd";
      i++;
      start = i;
      continue;
    }
    i += size;
  }
  return out + utf8Slice(b, start, b.length);
}

// trimSpaceBytes returns b without leading and trailing Unicode white
// space, as bytes.TrimSpace. Invalid UTF-8 stops the trimming.
export function trimSpaceBytes(b: Uint8Array): Uint8Array {
  let start = 0;
  while (start < b.length) {
    const [r, size] = decodeRune(b, start);
    if (!isSpace(r) || (r === RuneError && size === 1)) break;
    start += size;
  }
  let end = b.length;
  while (end > start) {
    const [r, size] = lastRune(b, start, end);
    if (!isSpace(r) || (r === RuneError && size === 1)) break;
    end -= size;
  }
  return b.subarray(start, end);
}

// lastRune decodes the rune that ends at b[end-1], not looking before start.
function lastRune(b: Uint8Array, start: number, end: number): [number, number] {
  const c = byteAt(b, end - 1);
  if (c < 0x80) return [c, 1];
  const lim = Math.max(start, end - 4);
  let i = end - 1;
  while (i > lim && (byteAt(b, i) & 0xc0) === 0x80) i--;
  const [r, size] = decodeRune(b.subarray(0, end), i);
  if (i + size !== end) return [RuneError, 1];
  return [r, size];
}

function leadInfo(c0: number): [size: number, lo: number, hi: number] {
  if (c0 >= 0xc2 && c0 <= 0xdf) return [2, 0x80, 0xbf];
  if (c0 === 0xe0) return [3, 0xa0, 0xbf];
  if (c0 === 0xed) return [3, 0x80, 0x9f];
  if (c0 >= 0xe1 && c0 <= 0xef) return [3, 0x80, 0xbf];
  if (c0 === 0xf0) return [4, 0x90, 0xbf];
  if (c0 === 0xf4) return [4, 0x80, 0x8f];
  if (c0 >= 0xf1 && c0 <= 0xf3) return [4, 0x80, 0xbf];
  return [1, 0, 0];
}

// A leading U+FEFF is a character here, not a byte order mark to drop.
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// text decodes bytes that are known to be valid UTF-8.
export function text(b: Uint8Array): string {
  return textDecoder.decode(b);
}

function utf8Slice(b: Uint8Array, start: number, end: number): string {
  return start === end ? "" : text(b.subarray(start, end));
}

function byteAt(b: Uint8Array, i: number): number {
  return b[i] ?? 0;
}
