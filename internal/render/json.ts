// report.json: the result set as one UTF-8 JSON document. The renderers are
// the other half of test seam B: hand-made results in, rendered reports out.

import { marshal } from "../gocompat/json.ts";
import { normalize } from "../resultset/normalize.ts";
import { ReportShape, type Set } from "../resultset/types.ts";

/**
 * json renders the result set as Go's json.Encoder with SetEscapeHTML(false)
 * and SetIndent("", "  ") wrote it: two-space indent, <, > and & as they are,
 * U+2028 and U+2029 escaped, and a trailing newline. It throws when a value
 * does not fit its field.
 */
export function json(s: Set): Uint8Array {
  normalize(s);
  return Buffer.from(
    marshal(s, ReportShape, { indent: "  ", escapeHTML: false }) + "\n",
    "utf8",
  );
}
