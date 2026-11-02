// How project and tool text enters report.md: as escaped running text, as a
// table cell, as a code span or as a code fence. None of them lets the text
// make headings, lists, links, HTML or a fence of its own.

import { fields, isControl, isSpace, trimSpace } from "../gocompat/strings.ts";
import { longestBacktickRun, quote } from "../resultset/quote.ts";

/**
 * clean removes control characters other than tab and newline and turns CRLF
 * and CR into LF. A lone surrogate, which is what invalid UTF-8 becomes, is
 * written as U+FFFD, as Go's strings.Map wrote an invalid byte.
 */
export function clean(s: string): string {
  s = s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0xfffd;
    if (ch === "\t" || ch === "\n") {
      out += ch;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out += "\ufffd";
    } else if (!isControl(c)) {
      out += ch;
    }
  }
  return out;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}

/**
 * text escapes project or tool text for running Markdown outside code:
 * control characters are removed, &, < and > are escaped so the text cannot
 * inject HTML, and Markdown syntax is backslash-escaped so the text cannot
 * make headings, lists, links, emphasis or code. Line breaks become spaces.
 */
export function text(s: string): string {
  return mdEscape(fields(htmlEscape(clean(s))).join(" "));
}

const wordRune = /^[\p{L}\p{Nd}]$/u;

// isWordRune is Go's unicode.IsLetter || unicode.IsDigit.
function isWordRune(r: string | undefined): boolean {
  return r !== undefined && wordRune.test(r);
}

function allDigits(rs: readonly string[]): boolean {
  return rs.length > 0 && rs.every((r) => r >= "0" && r <= "9");
}

/**
 * mdEscape backslash-escapes the characters that start Markdown syntax in
 * running text. An underscore between two letters or digits cannot start
 * emphasis, so it stays readable.
 */
export function mdEscape(s: string): string {
  const rs = Array.from(s);
  let out = "";
  rs.forEach((r, i) => {
    switch (r) {
      case "\\":
      case "`":
      case "*":
      case "[":
      case "]":
      case "~":
        out += "\\";
        break;
      case "_":
        if (!(i > 0 && isWordRune(rs[i - 1]) && isWordRune(rs[i + 1]))) {
          out += "\\";
        }
        break;
      case "#":
      case "-":
      case "+":
      case "=":
        if (i === 0) {
          out += "\\";
        }
        break;
      case ".":
      case ")":
        // "1." and "2)" at the start would begin a numbered list.
        if (
          i > 0 &&
          allDigits(rs.slice(0, i)) &&
          (i + 1 === rs.length || rs[i + 1] === " ")
        ) {
          out += "\\";
        }
        break;
    }
    out += r;
  });
  return out;
}

/** cell is text for a table cell: pipes cannot start a new cell. */
export function cell(s: string): string {
  return text(s).replaceAll("|", "\\|");
}

/**
 * fence puts project or tool text into a code fence that is longer than the
 * longest backtick run inside the text.
 */
export function fence(s: string): string {
  s = clean(s).replace(/\n+$/, "");
  const f = "`".repeat(Math.max(3, longestBacktickRun(s) + 1));
  return f + "\n" + s + "\n" + f + "\n";
}

/**
 * code puts text into an inline code span, see resultset.quote. Control
 * characters are cleaned first. Inside a table, use cellCode.
 */
export function code(s: string): string {
  return quote(clean(s));
}

/** cellCode is code for a table cell. */
export function cellCode(s: string): string {
  return code(s).replaceAll("|", "\\|");
}

function firstRune(s: string): number {
  return s.codePointAt(0) ?? 0;
}

function lastRune(s: string): number {
  const rs = Array.from(s);
  return rs[rs.length - 1]?.codePointAt(0) ?? 0;
}

/**
 * reasonText renders a reason or Limitation message. Project text that the
 * producer quoted with resultset.quote is a Markdown code span: it is shown
 * as a code span, without HTML escaping, so `&&` stays `&&`. Everything else
 * is escaped as text. A backtick run that no run of the same length closes is
 * not a span and is escaped like any other text.
 */
export function reasonText(s: string): string {
  s = clean(s);
  let out = "";
  let plain = 0; // start of the text not yet written
  const flush = (end: number) => {
    const seg = s.slice(plain, end);
    if (seg === "") {
      return;
    }
    if (trimSpace(seg) === "") {
      out += " ";
      return;
    }
    if (isSpace(firstRune(seg))) {
      out += " ";
    }
    out += text(seg);
    if (isSpace(lastRune(seg))) {
      out += " ";
    }
  };
  for (let i = 0; i < s.length;) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < s.length && s[i + n] === "`") {
      n++;
    }
    const end = closingRun(s, i + n, n);
    if (end < 0) {
      i += n;
      continue;
    }
    flush(i);
    let content = s.slice(i + n, end);
    if (
      content.length > 1 &&
      content.startsWith(" ") &&
      content.endsWith(" ") &&
      content.replace(/^ +| +$/g, "") !== ""
    ) {
      content = content.slice(1, -1);
    }
    out += code(content);
    i = end + n;
    plain = i;
  }
  flush(s.length);
  return out;
}

/** reasonCell is reasonText for a table cell. */
export function reasonCell(s: string): string {
  return reasonText(s).replaceAll("|", "\\|");
}

// closingRun returns the index of the next run of exactly n backticks at or
// after from, or -1.
function closingRun(s: string, from: number, n: number): number {
  for (let j = from; j < s.length;) {
    if (s[j] !== "`") {
      j++;
      continue;
    }
    let m = 0;
    while (j + m < s.length && s[j + m] === "`") {
      m++;
    }
    if (m === n) {
      return j;
    }
    j += m;
  }
  return -1;
}

/** joinCode lists code spans as "`a`, `b`". */
export function joinCode(ss: readonly string[]): string {
  return ss.map(code).join(", ");
}

export function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}

/** ptrStr is the text of an optional field, "" when it is null. */
export function ptrStr(p: string | null): string {
  return p ?? "";
}

/** linkTarget makes a relative path safe inside a Markdown link target. */
export function linkTarget(p: string): string {
  return clean(p).replace(/[() <>]/g, (c) =>
    c === "("
      ? "%28"
      : c === ")"
        ? "%29"
        : c === " "
          ? "%20"
          : c === "<"
            ? "%3C"
            : "%3E",
  );
}
