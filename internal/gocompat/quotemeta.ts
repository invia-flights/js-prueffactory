// Go's regexp.QuoteMeta (the rest of Go's regexp is in regexp.ts).

const special = new Set("\\.+*?()|[]{}^$");

/**
 * quoteMeta is Go's regexp.QuoteMeta: every character of `\.+*?()|[]{}^$`
 * gets a backslash, nothing else changes. JavaScript's RegExp.escape escapes
 * far more, and its output would show in the Report.
 */
export function quoteMeta(s: string): string {
  let out = "";
  for (const ch of s) {
    out += special.has(ch) ? "\\" + ch : ch;
  }
  return out;
}
