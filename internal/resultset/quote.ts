import { fields, isControl, isSpace } from "../gocompat/strings.ts";

/**
 * quote marks project text inside a reason or Limitation message (a test
 * script, a chain step) as quoted text. The result is a Markdown code span:
 * the delimiter is longer than any backtick run in the text, and the span is
 * padded with one space when the text begins or ends with a backtick. Control
 * characters are dropped and line breaks become spaces.
 *
 * report.md shows such a span as it is, without HTML escaping, so `&&` reads
 * as `&&`. Everything outside the spans of a reason stays escaped there.
 */
export function quote(text: string): string {
  let s = fields(withoutControls(text)).join(" ");
  if (s === "") {
    return "";
  }
  const d = "`".repeat(longestBacktickRun(s) + 1);
  if (s.startsWith("`") || s.endsWith("`")) {
    s = " " + s + " ";
  }
  return d + s + d;
}

/**
 * withoutControls drops the control characters of a text from the project,
 * but keeps white space, so that an escape sequence in a test title does not
 * reach a terminal through the Report.
 */
export function withoutControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (isControl(c) && !isSpace(c)) {
      continue;
    }
    out += ch;
  }
  return out;
}

/** longestBacktickRun returns the length of the longest run of backticks in s. */
export function longestBacktickRun(s: string): number {
  let longest = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "`") {
      cur++;
      longest = Math.max(longest, cur);
    } else {
      cur = 0;
    }
  }
  return longest;
}
