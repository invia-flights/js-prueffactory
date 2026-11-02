// The cuts of project and tool text. Every one cuts between characters, so
// the result is valid UTF-8 whenever the text was. Lengths are UTF-8 bytes, as
// in Go.
import { cutUTF8, trimSpace, utf8Length } from "../gocompat/strings.ts";

/** cutBytes is the first n bytes of s, ending at a character. */
export function cutBytes(s: string, n: number): string {
  return cutUTF8(s, n);
}

/** shorten is s cut to about n bytes, with "..." where it was cut. */
export function shorten(s: string, n: number): string {
  if (utf8Length(s) <= n) {
    return s;
  }
  return cutBytes(s, n) + "...";
}

/** lastBytes returns the last n bytes of s, starting at a character. */
export function lastBytes(s: string, n: number): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= n) {
    return s;
  }
  let start = b.length - n;
  // Skip continuation bytes (10xxxxxx), as Go skips non-rune-start bytes.
  while (start < b.length && ((b[start] ?? 0) & 0xc0) === 0x80) {
    start++;
  }
  return b.subarray(start).toString("utf8");
}

/**
 * tail is the end of s, at most n bytes of it, with "..." where the start
 * was cut.
 */
export function tail(s: string, n: number): string {
  s = trimSpace(s);
  if (utf8Length(s) <= n) {
    return s;
  }
  return "..." + lastBytes(s, n);
}

/** cutList shortens a list to n entries and says how many were left out. */
export function cutList(list: readonly string[], n: number): string[] {
  if (list.length <= n) {
    return [...list];
  }
  return [...list.slice(0, n), `and ${String(list.length - n)} more`];
}
