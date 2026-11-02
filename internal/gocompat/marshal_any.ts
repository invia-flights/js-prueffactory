// json.Marshal of the values that Go holds as `any`: nil, bool, float64 or int,
// string, []any, map[string]any and structs. Where json.ts needs a Shape for
// every struct, this walks the value itself:
//
//   - a Map is a Go map: its keys come out sorted byte-wise;
//   - a plain object is a Go struct: its properties come out in insertion
//     order, which the caller makes the declaration order of the Go fields;
//   - an array is a slice, null and undefined are nil.
//
// Strings are written as Go writes them (quoteJSONString) and numbers as
// formatNumber. The walk keeps its own stack, as Go copes with deep values and
// JavaScript recursion does not.
import { formatNumber, quoteJSONString } from "./json.ts";
import { compareBytes } from "./strings.ts";

export interface MarshalAnyOptions {
  /** indent is the indent string per level, as MarshalIndent's; none is compact. */
  readonly indent?: string;
  /** escapeHTML escapes <, > and &; Go's default is true. */
  readonly escapeHTML?: boolean;
}

type Frame =
  | { kind: "array"; items: unknown[]; i: number }
  | { kind: "object"; entries: [string, unknown][]; i: number };

function entriesOf(v: unknown): [string, unknown][] | undefined {
  if (v instanceof Map) {
    const entries = [...(v as Map<string, unknown>)];
    entries.sort(([a], [b]) => compareBytes(a, b));
    return entries;
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return Object.entries(v as Record<string, unknown>);
  }
  return undefined;
}

/** marshalAny writes a value as Go's encoding/json writes it. */
export function marshalAny(
  value: unknown,
  options: MarshalAnyOptions = {},
): string {
  const indent = options.indent ?? "";
  const escapeHTML = options.escapeHTML ?? true;
  const colon = indent === "" ? ":" : ": ";
  const out: string[] = [];
  const stack: Frame[] = [];

  const newline = (depth: number): string =>
    indent === "" ? "" : "\n" + indent.repeat(depth);

  // open writes a scalar, or the opening bracket of a container (pushing its
  // frame), and returns nothing.
  const open = (v: unknown): void => {
    if (v === null || v === undefined) {
      out.push("null");
    } else if (typeof v === "string") {
      out.push(quoteJSONString(v, escapeHTML));
    } else if (typeof v === "number") {
      out.push(formatNumber(v));
    } else if (typeof v === "bigint") {
      out.push(v.toString());
    } else if (typeof v === "boolean") {
      out.push(v ? "true" : "false");
    } else if (Array.isArray(v)) {
      const items: unknown[] = v;
      if (items.length === 0) {
        out.push("[]");
      } else {
        out.push("[");
        stack.push({ kind: "array", items, i: 0 });
      }
    } else {
      const entries = entriesOf(v);
      if (entries === undefined) {
        throw new TypeError(`json: unsupported type ${typeof v}`);
      }
      if (entries.length === 0) {
        out.push("{}");
      } else {
        out.push("{");
        stack.push({ kind: "object", entries, i: 0 });
      }
    }
  };

  open(value);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      break;
    }
    const depth = stack.length;
    const n = top.kind === "array" ? top.items.length : top.entries.length;
    if (top.i >= n) {
      stack.pop();
      out.push(newline(depth - 1) + (top.kind === "array" ? "]" : "}"));
      continue;
    }
    out.push((top.i > 0 ? "," : "") + newline(depth));
    if (top.kind === "array") {
      open(top.items[top.i]);
    } else {
      const entry = top.entries[top.i];
      if (entry === undefined) {
        break;
      }
      out.push(quoteJSONString(entry[0], escapeHTML) + colon);
      open(entry[1]);
    }
    top.i++;
  }
  return out.join("");
}
