// Go's encoding/json output, field by field. A Go struct fixes the order and
// the names of its JSON fields; here a Shape does, so the bytes do not depend
// on the order in which an object's keys were set.
//
// Go's encoder differs from JSON.stringify: it escapes U+2028 and U+2029,
// writes \b and \f, escapes <, > and & unless SetEscapeHTML(false), writes a
// nil slice as null, keeps the sign of negative zero and formats times as RFC
// 3339 with trimmed fractional seconds.

import { compareBytes, zeroPad } from "./strings.ts";

/** RedactTag is the `redact` struct tag of a report field (see redaction). */
export type RedactTag = "vocabulary" | "identifier";

export interface ScalarShape {
  readonly kind: "string" | "number" | "bool" | "time";
}
export interface NullableShape {
  readonly kind: "nullable";
  readonly of: Shape;
}
export interface ArrayShape {
  readonly kind: "array";
  readonly of: Shape;
}
export interface Field {
  /** key is the JSON name, which is also the TypeScript property name. */
  readonly key: string;
  readonly shape: Shape;
  readonly redact?: RedactTag;
  /** omit leaves the field out of the JSON when it returns true for its owner. */
  readonly omit?: (owner: Record<string, unknown>) => boolean;
}
export interface ObjectShape {
  readonly kind: "object";
  readonly fields: readonly Field[];
}
export interface MapShape {
  readonly kind: "map";
  readonly of: Shape;
}
export type Shape =
  ScalarShape | NullableShape | ArrayShape | ObjectShape | MapShape;

export const string: ScalarShape = { kind: "string" };
export const number: ScalarShape = { kind: "number" };
export const bool: ScalarShape = { kind: "bool" };
/** time is a Date, written as Go writes a time.Time. */
export const time: ScalarShape = { kind: "time" };

/** nullable is a Go pointer: null or the value. */
export function nullable(of: Shape): NullableShape {
  return { kind: "nullable", of };
}

/** array is a Go slice. */
export function array(of: Shape): ArrayShape {
  return { kind: "array", of };
}

/**
 * map is a Go map with string keys: a Map or a plain object, written with
 * its keys sorted byte-wise; null or undefined is a nil map.
 */
export function map(of: Shape): MapShape {
  return { kind: "map", of };
}

export interface FieldOptions<T> {
  readonly redact?: RedactTag;
  readonly omit?: (owner: T) => boolean;
}

/** FieldSpec names a property of T, its shape and optionally its redact tag. */
export type FieldSpec<T> = readonly [
  key: keyof T & string,
  shape: Shape,
  options?: RedactTag | FieldOptions<T>,
];

/** object is a Go struct: its JSON fields in declaration order. */
export function object<T>(specs: readonly FieldSpec<T>[]): ObjectShape {
  return {
    kind: "object",
    fields: specs.map(([key, shape, options]): Field => {
      const opts: FieldOptions<T> =
        typeof options === "string" ? { redact: options } : (options ?? {});
      return {
        key,
        shape,
        ...(opts.redact === undefined ? {} : { redact: opts.redact }),
        ...(opts.omit === undefined
          ? {}
          : {
              omit: opts.omit as unknown as (
                owner: Record<string, unknown>,
              ) => boolean,
            }),
      };
    }),
  };
}

const hex = "0123456789abcdef";

/**
 * quoteJSONString writes a string as Go's encoder does. escapeHTML is true
 * for json.Marshal and MarshalIndent, false for an Encoder with
 * SetEscapeHTML(false). A lone surrogate becomes the character U+FFFD, as
 * invalid UTF-8 does in Go 1.27 (the frozen build's encoder writes U+FFFD
 * itself there, not the escape \ufffd that Go versions before it wrote).
 */
export function quoteJSONString(s: string, escapeHTML: boolean): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | undefined;
    if (c < 0x20) {
      switch (c) {
        case 0x08:
          esc = "\\b";
          break;
        case 0x0c:
          esc = "\\f";
          break;
        case 0x0a:
          esc = "\\n";
          break;
        case 0x0d:
          esc = "\\r";
          break;
        case 0x09:
          esc = "\\t";
          break;
        default:
          esc = "\\u00" + hex.charAt(c >> 4) + hex.charAt(c & 0xf);
      }
    } else if (c === 0x22) {
      esc = '\\"';
    } else if (c === 0x5c) {
      esc = "\\\\";
    } else if (escapeHTML && (c === 0x3c || c === 0x3e || c === 0x26)) {
      esc = "\\u00" + hex.charAt(c >> 4) + hex.charAt(c & 0xf);
    } else if (c === 0x2028 || c === 0x2029) {
      esc = c === 0x2028 ? "\\u2028" : "\\u2029";
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const pair =
        c <= 0xdbff &&
        i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 &&
        s.charCodeAt(i + 1) <= 0xdfff;
      if (pair) {
        i++;
        continue;
      }
      esc = "\ufffd";
    }
    if (esc !== undefined) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return out + s.slice(start) + '"';
}

/** formatNumber writes a float64 or an integer as Go's encoder does. */
export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) {
    throw new TypeError(`json: unsupported value: ${String(x)}`);
  }
  // Go switches to exponent form below 1e-6 and from 1e21 on, as JavaScript
  // does, and writes the same shortest digits; only negative zero differs.
  return Object.is(x, -0) ? "-0" : String(x);
}

/** formatRFC3339 is Go's t.UTC().Format(time.RFC3339): seconds, no fraction. */
export function formatRFC3339(d: Date): string {
  return (
    `${zeroPad(d.getUTCFullYear(), 4)}-${zeroPad(d.getUTCMonth() + 1, 2)}-${zeroPad(d.getUTCDate(), 2)}` +
    `T${zeroPad(d.getUTCHours(), 2)}:${zeroPad(d.getUTCMinutes(), 2)}:${zeroPad(d.getUTCSeconds(), 2)}Z`
  );
}

/**
 * formatTime is how Go marshals a UTC time.Time: RFC 3339 with the fractional
 * seconds trimmed of trailing zeros. A Date holds milliseconds; Go held
 * nanoseconds, so a Go Report can show more digits.
 */
export function formatTime(d: Date): string {
  const base = formatRFC3339(d);
  const ms = d.getUTCMilliseconds();
  if (ms === 0) {
    return base;
  }
  return `${base.slice(0, -1)}.${zeroPad(ms, 3).replace(/0+$/, "")}Z`;
}

export interface MarshalOptions {
  /** indent is the indent string per level, as MarshalIndent's; none is compact. */
  readonly indent?: string;
  /** escapeHTML escapes <, > and &; Go's default is true. */
  readonly escapeHTML?: boolean;
}

function fail(shape: Shape, value: unknown): never {
  throw new TypeError(
    `json: ${typeof value} where the shape wants ${shape.kind}`,
  );
}

/**
 * marshal writes a value as Go's encoding/json writes the struct that the
 * shape describes. Without an indent it is json.Marshal's compact form; with
 * one it is MarshalIndent's (and the Encoder's, minus its trailing newline).
 */
export function marshal(
  value: unknown,
  shape: Shape,
  options: MarshalOptions = {},
): string {
  const indent = options.indent ?? "";
  const escapeHTML = options.escapeHTML ?? true;

  const write = (v: unknown, s: Shape, depth: number): string => {
    switch (s.kind) {
      case "string":
        return typeof v === "string"
          ? quoteJSONString(v, escapeHTML)
          : fail(s, v);
      case "number":
        return typeof v === "number" ? formatNumber(v) : fail(s, v);
      case "bool":
        if (typeof v !== "boolean") {
          return fail(s, v);
        }
        return v ? "true" : "false";
      case "time":
        return v instanceof Date ? `"${formatTime(v)}"` : fail(s, v);
      case "nullable":
        return v === null || v === undefined ? "null" : write(v, s.of, depth);
      case "array": {
        if (v === null || v === undefined) {
          return "null";
        }
        if (!Array.isArray(v)) {
          return fail(s, v);
        }
        const items: unknown[] = v;
        if (items.length === 0) {
          return "[]";
        }
        const parts = items.map((item) => write(item, s.of, depth + 1));
        return wrap("[", "]", parts, depth);
      }
      case "object": {
        if (typeof v !== "object" || v === null) {
          return fail(s, v);
        }
        const owner = v as Record<string, unknown>;
        const parts: string[] = [];
        for (const f of s.fields) {
          if (f.omit?.(owner) === true) {
            continue;
          }
          const name = quoteJSONString(f.key, escapeHTML);
          parts.push(
            `${name}:${indent === "" ? "" : " "}${write(owner[f.key], f.shape, depth + 1)}`,
          );
        }
        return parts.length === 0 ? "{}" : wrap("{", "}", parts, depth);
      }
      case "map": {
        if (v === null || v === undefined) {
          return "null";
        }
        if (typeof v !== "object") {
          return fail(s, v);
        }
        const entries: [string, unknown][] =
          v instanceof Map
            ? [...(v as Map<string, unknown>)]
            : Object.entries(v as Record<string, unknown>);
        entries.sort(([a], [b]) => compareBytes(a, b));
        const parts = entries.map(
          ([key, item]) =>
            `${quoteJSONString(key, escapeHTML)}:${indent === "" ? "" : " "}${write(item, s.of, depth + 1)}`,
        );
        return parts.length === 0 ? "{}" : wrap("{", "}", parts, depth);
      }
    }
  };

  const wrap = (
    open: string,
    close: string,
    parts: string[],
    depth: number,
  ): string => {
    if (indent === "") {
      return open + parts.join(",") + close;
    }
    const inner = "\n" + indent.repeat(depth + 1);
    return (
      open +
      inner +
      parts.join("," + inner) +
      "\n" +
      indent.repeat(depth) +
      close
    );
  };

  return write(value, shape, 0);
}
