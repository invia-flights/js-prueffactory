// json.Unmarshal as the Go build runs it. Go 1.27 implements the v1
// encoding/json API on top of encoding/json/v2 with the v1 options
// (GOEXPERIMENT jsonv2 is on by default), so the syntax errors, their
// offsets, the field paths of type errors and the merge rules below follow
// that implementation, not the historical v1 decoder.
//
// Only the Go types the port decodes are modelled: string, bool, int,
// float64, json.RawMessage, interface{}, pointers, map[string]T, []T and structs with
// json names.
import { quoteBytes, quoteRune } from "./fmt.ts";
import { isPrint, isSpace } from "./strings.ts";
import { decodeRune, fullRune, RuneError, text } from "./utf8.ts";

// SyntaxError is json.SyntaxError: the message and the offset after which
// the error occurred.
export class SyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "SyntaxError";
    this.offset = offset;
  }
}

// UnmarshalTypeError is json.UnmarshalTypeError: a JSON value that does not
// fit the Go type at that place. field is the path from the root, its
// segments joined by "." ("" for the top level).
export class UnmarshalTypeError extends Error {
  readonly value: string;
  readonly type: string;
  readonly offset: number;
  readonly field: string;
  constructor(value: string, type: string, offset: number, field: string) {
    super(`json: cannot unmarshal ${value} into Go value of type ${type}`);
    this.name = "UnmarshalTypeError";
    this.value = value;
    this.type = type;
    this.offset = offset;
    this.field = field;
  }
}

export interface Field {
  // The json name from the struct tag.
  readonly name: string;
  readonly schema: Schema;
}

// Schema describes the Go type a value is decoded into. type is the Go type
// as reflect.Type.String prints it, used in UnmarshalTypeError.
export type Schema =
  | { readonly kind: "string" }
  | { readonly kind: "bool" }
  | { readonly kind: "int" }
  | { readonly kind: "float" }
  | { readonly kind: "raw" }
  | { readonly kind: "any" }
  | { readonly kind: "pointer"; readonly elem: Schema }
  | { readonly kind: "map"; readonly type: string; readonly elem: Schema }
  | { readonly kind: "slice"; readonly type: string; readonly elem: Schema }
  | {
      readonly kind: "struct";
      readonly type: string;
      readonly fields: readonly Field[];
    };

export const stringSchema: Schema = { kind: "string" };

// GoSlice is a decoded Go slice: the first len elements of backing. The
// elements past len stay, because Go reuses them when the same slice is
// decoded into again (a repeated key in the input).
export class GoSlice {
  backing: unknown[] = [];
  len = 0;
  items(): unknown[] {
    return this.backing.slice(0, this.len);
  }
}

// Decoded values: string -> string, bool -> boolean, int -> bigint, float -> number,
// raw -> Uint8Array | null, any -> AnyValue, pointer -> value | null, map -> Map | null,
// slice -> GoSlice | null, struct -> a record keyed by json name.
export type Value = unknown;

// AnyValue is what JSON decodes to in an interface{}: nil, bool, float64,
// string, []interface{} or map[string]interface{}.
export type AnyValue =
  null | boolean | number | string | AnyValue[] | Map<string, AnyValue>;

export function zeroValue(schema: Schema): Value {
  switch (schema.kind) {
    case "string":
      return "";
    case "bool":
      return false;
    case "int":
      return 0n;
    case "float":
      return 0;
    case "raw":
    case "any":
    case "pointer":
    case "map":
    case "slice":
      return null;
    case "struct": {
      const out: Record<string, Value> = {};
      for (const f of schema.fields) out[f.name] = zeroValue(f.schema);
      return out;
    }
  }
}

// unmarshal decodes data into a fresh zero value of schema. It throws a
// SyntaxError for input that is not JSON, and otherwise the first
// UnmarshalTypeError in document order.
export function unmarshal(data: Uint8Array, schema: Schema): Value {
  const err = checkValid(data);
  if (err) throw err;
  const d = new Decoder(data);
  const [value] = d.decode(schema, zeroValue(schema), ws(data, 0), []);
  if (d.firstError) throw d.firstError;
  return value;
}

// unmarshalPartial is unmarshal for a caller that ignores the error, as
// `_ = json.Unmarshal(data, &v)` does: it returns what Go leaves in v (the
// zero value after a syntax error, everything that fitted after a type
// error) and the error.
export function unmarshalPartial(
  data: Uint8Array,
  schema: Schema,
): [Value, SyntaxError | UnmarshalTypeError | undefined] {
  const err = checkValid(data);
  if (err) return [zeroValue(schema), err];
  const d = new Decoder(data);
  const [value] = d.decode(schema, zeroValue(schema), ws(data, 0), []);
  return [value, d.firstError];
}

// checkValid validates data as one JSON value and returns the syntax error
// Go reports, if any.
export function checkValid(data: Uint8Array): SyntaxError | undefined {
  try {
    const pos = ws(data, 0);
    if (pos >= data.length) throw eof(data.length);
    const c = data[pos];
    if (c === 0x2c || c === 0x3a) {
      throw invalidChar(data, pos, "looking for beginning of value");
    }
    const end = ws(data, consumeValue(data, pos));
    if (end < data.length) {
      throw invalidChar(data, end, "after top-level value");
    }
    return undefined;
  } catch (e) {
    if (e instanceof SyntaxError) return e;
    throw e;
  }
}

const maxNestingDepth = 10000;

// consumeValue returns the end of the JSON value at pos. It keeps the open
// objects and arrays on its own stack: a document may nest them 10000 deep,
// more than the call stack holds.
function consumeValue(b: Uint8Array, pos: number): number {
  const open: number[] = [];
  let n = pos;
  for (;;) {
    const c = b[n] ?? 0;
    if (c === 0x7b || c === 0x5b) {
      if (open.length + 1 === maxNestingDepth + 1) {
        throw new SyntaxError("exceeded max depth", n + 1);
      }
      open.push(c);
      n = wsOrEOF(b, n + 1);
      if (b[n] !== c + 2) {
        // "}" and "]" are two bytes after "{" and "[".
        if (c === 0x7b) n = consumeName(b, n);
        continue;
      }
      open.pop();
      n++;
    } else {
      n = consumeScalar(b, n);
    }
    // After a value: close what ends here, or go on with the next member.
    for (;;) {
      const top = open.at(-1);
      if (top === undefined) return n;
      n = wsOrEOF(b, n);
      if (b[n] === 0x2c) {
        n = wsOrEOF(b, n + 1);
        if (top === 0x7b) n = consumeName(b, n);
        break;
      }
      if (b[n] !== top + 2) {
        throw invalidChar(
          b,
          n,
          top === 0x7b ? "after object key:value pair" : "after array element",
        );
      }
      open.pop();
      n++;
    }
  }
}

// consumeName consumes an object member name and its colon and returns the
// start of the member value.
function consumeName(b: Uint8Array, pos: number): number {
  const n = wsOrEOF(b, consumeString(b, pos));
  if (b[n] !== 0x3a) throw invalidChar(b, n, "after object key");
  return wsOrEOF(b, n + 1);
}

function consumeScalar(b: Uint8Array, pos: number): number {
  const c = b[pos] ?? 0;
  switch (c) {
    case 0x6e: // n
      return consumeLiteral(b, pos, "null");
    case 0x74: // t
      return consumeLiteral(b, pos, "true");
    case 0x66: // f
      return consumeLiteral(b, pos, "false");
    case 0x22: // "
      return consumeString(b, pos);
  }
  if (c === 0x2d || isDigit(c)) return consumeNumber(b, pos);
  throw invalidChar(b, pos, "looking for beginning of value");
}

function consumeLiteral(b: Uint8Array, pos: number, lit: string): number {
  for (let i = 0; i < lit.length; i++) {
    if (pos + i >= b.length) throw eof(b.length);
    if (b[pos + i] !== lit.charCodeAt(i)) {
      throw invalidChar(
        b,
        pos + i,
        `in literal ${lit} (expecting ${quoteRune(lit.charCodeAt(i))})`,
      );
    }
  }
  return pos + lit.length;
}

function consumeString(b: Uint8Array, pos: number): number {
  if (b[pos] !== 0x22) {
    throw invalidChar(b, pos, "looking for beginning of object key string");
  }
  let n = pos + 1;
  for (;;) {
    while (n < b.length && noEscape(b[n] ?? 0)) n++;
    if (n >= b.length) throw eof(n);
    if (b[n] === 0x22) return n + 1;
    const [r, size] = decodeRune(b, n);
    if (size > 1) {
      n += size;
    } else if (r === 0x5c) {
      if (n + 2 > b.length) throw eof(n);
      const e = b[n + 1] ?? 0;
      if (e === 0x75) {
        if (n + 6 > b.length) {
          if (hasEscapedUTF16Prefix(b.subarray(n))) throw eof(n);
          throw invalidEscape(b, n, b.length);
        }
        if (parseHex4(b, n + 2) < 0) throw invalidEscape(b, n, n + 6);
        n += 6;
      } else if ('"\\/bfnrt'.includes(String.fromCharCode(e))) {
        n += 2;
      } else {
        throw invalidEscape(b, n, n + 2);
      }
    } else if (r === RuneError) {
      if (!fullRune(b, n)) throw eof(n);
      n++;
    } else {
      throw invalidChar(b, n, "in string");
    }
  }
}

function consumeNumber(b: Uint8Array, pos: number): number {
  let n = pos;
  if (b[n] === 0x2d) n++;
  if (n >= b.length) throw eof(pos);
  if (b[n] === 0x30) {
    n++;
  } else if (isDigit(b[n] ?? 0)) {
    while (n < b.length && isDigit(b[n] ?? 0)) n++;
  } else {
    throw invalidChar(b, n, "in numeric literal");
  }
  if (n < b.length && b[n] === 0x2e) {
    n++;
    n = digits(b, n, pos);
  }
  if (n < b.length && (b[n] === 0x65 || b[n] === 0x45)) {
    n++;
    if (n < b.length && (b[n] === 0x2b || b[n] === 0x2d)) n++;
    n = digits(b, n, pos);
  }
  return n;
}

// digits consumes the digits of a fraction or exponent, at least one.
function digits(b: Uint8Array, n: number, start: number): number {
  if (n >= b.length) throw eof(start);
  if (!isDigit(b[n] ?? 0)) throw invalidChar(b, n, "in numeric literal");
  while (n < b.length && isDigit(b[n] ?? 0)) n++;
  return n;
}

function wsOrEOF(b: Uint8Array, pos: number): number {
  const n = ws(b, pos);
  if (n >= b.length) throw eof(n);
  return n;
}

function ws(b: Uint8Array, pos: number): number {
  let n = pos;
  while (n < b.length) {
    const c = b[n];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) break;
    n++;
  }
  return n;
}

function eof(offset: number): SyntaxError {
  return new SyntaxError("unexpected end of JSON input", offset);
}

function invalidChar(b: Uint8Array, pos: number, where: string): SyntaxError {
  const [r, size] = decodeRune(b, pos);
  const what =
    r === RuneError && size === 1
      ? `'\\x${(b[pos] ?? 0).toString(16)}'`
      : quoteRune(r);
  return new SyntaxError(
    `invalid character ${what} ${where}`,
    pos + Math.max(size, 1),
  );
}

function invalidEscape(b: Uint8Array, start: number, end: number): SyntaxError {
  const what = b.subarray(start, end);
  return new SyntaxError(
    `invalid escape sequence ${quoteText(what)} in string`,
    end,
  );
}

// quoteText renders the invalid text of an error as Go's InvalidTextError
// does: backquoted unless it needs escaping.
function quoteText(what: Uint8Array): string {
  let needEscape = false;
  for (let i = 0; i < what.length;) {
    const [r, size] = decodeRune(what, i);
    if (r === 0x60 || r === RuneError || isSpace(r) || !isPrint(r)) {
      needEscape = true;
    }
    i += size;
  }
  return needEscape ? quoteBytes(what) : "`" + text(what) + "`";
}

function hasEscapedUTF16Prefix(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = b[i] ?? 0;
    if (i === 0 && c !== 0x5c) return false;
    if (i === 1 && c !== 0x75) return false;
    if (i >= 2 && i < 6 && hexValue(c) < 0) return false;
  }
  return true;
}

function noEscape(c: number): boolean {
  return c < 0x80 && c >= 0x20 && c !== 0x5c && c !== 0x22;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

function parseHex4(b: Uint8Array, at: number): number {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const h = hexValue(b[at + i] ?? 0);
    if (h < 0) return -1;
    v = v * 16 + h;
  }
  return v;
}

// unquote decodes a validated JSON string at b[start:end] (quotes included)
// as Go does: invalid UTF-8 bytes and unpaired surrogate escapes become
// U+FFFD, one per byte or escape.
export function unquote(b: Uint8Array, start: number, end: number): string {
  let out = "";
  let n = start + 1;
  const last = end - 1;
  let run = n;
  const flush = (to: number) => {
    if (to > run) out += text(b.subarray(run, to));
  };
  while (n < last) {
    const c = b[n] ?? 0;
    if (c === 0x5c) {
      flush(n);
      const e = b[n + 1] ?? 0;
      if (e === 0x75) {
        let r = parseHex4(b, n + 2);
        n += 6;
        if (r >= 0xd800 && r <= 0xdfff) {
          const r2 =
            b[n] === 0x5c && b[n + 1] === 0x75 ? parseHex4(b, n + 2) : -1;
          if (r <= 0xdbff && r2 >= 0xdc00 && r2 <= 0xdfff) {
            r = 0x10000 + ((r - 0xd800) << 10) + (r2 - 0xdc00);
            n += 6;
          } else {
            r = RuneError;
          }
        }
        out += String.fromCodePoint(r);
      } else {
        out += unescaped[e] ?? String.fromCharCode(e);
        n += 2;
      }
      run = n;
      continue;
    }
    if (c < 0x80) {
      n++;
      continue;
    }
    const [r, size] = decodeRune(b, n);
    if (r === RuneError && size === 1) {
      flush(n);
      out += "\ufffd";
      n++;
      run = n;
      continue;
    }
    n += size;
  }
  flush(n);
  return out;
}

const unescaped: Record<number, string> = {
  0x62: "\b",
  0x66: "\f",
  0x6e: "\n",
  0x72: "\r",
  0x74: "\t",
};

// skipValue returns the end of the validated value at pos.
function skipValue(b: Uint8Array, pos: number): number {
  const c = b[pos] ?? 0;
  if (c === 0x22) return stringEnd(b, pos);
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    let n = pos;
    for (;;) {
      const x = b[n] ?? 0;
      if (x === 0x22) {
        n = stringEnd(b, n);
        continue;
      }
      if (x === 0x7b || x === 0x5b) depth++;
      if (x === 0x7d || x === 0x5d) depth--;
      n++;
      if (depth === 0) return n;
    }
  }
  let n = pos;
  while (n < b.length && !isDelimiter(b[n] ?? 0)) n++;
  return n;
}

function stringEnd(b: Uint8Array, pos: number): number {
  let n = pos + 1;
  for (;;) {
    const c = b[n];
    if (c === 0x22) return n + 1;
    n += c === 0x5c ? 2 : 1;
  }
}

function isDelimiter(c: number): boolean {
  return (
    c === 0x2c ||
    c === 0x7d ||
    c === 0x5d ||
    c === 0x20 ||
    c === 0x09 ||
    c === 0x0d ||
    c === 0x0a
  );
}

const kindNames: Record<number, string> = {
  0x22: "string",
  0x74: "bool",
  0x66: "bool",
  0x5b: "array",
  0x7b: "object",
  0x6e: "null",
};

const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;

class Decoder {
  readonly b: Uint8Array;
  firstError: UnmarshalTypeError | undefined;
  constructor(b: Uint8Array) {
    this.b = b;
  }

  // decode decodes the value at pos into current and returns the new value
  // and the end of the JSON value.
  decode(
    schema: Schema,
    current: Value,
    pos: number,
    path: readonly string[],
  ): [Value, number] {
    const b = this.b;
    const c = b[pos] ?? 0;
    const end = skipValue(b, pos);
    if (c === 0x6e && schema.kind !== "raw") {
      // null: pointers, maps and slices become nil; other values stay.
      switch (schema.kind) {
        case "any":
        case "pointer":
        case "map":
        case "slice":
          return [null, end];
        default:
          return [current, end];
      }
    }
    switch (schema.kind) {
      case "string":
        if (c !== 0x22) return this.fail("string", current, pos, end, path);
        return [unquote(b, pos, end), end];
      case "bool":
        if (c !== 0x74 && c !== 0x66) {
          return this.fail("bool", current, pos, end, path);
        }
        return [c === 0x74, end];
      case "int":
        if (c !== 0x2d && !isDigit(c)) {
          return this.fail("int", current, pos, end, path);
        }
        return [this.decodeInt(current, pos, end, path), end];
      case "float":
        if (c !== 0x2d && !isDigit(c)) {
          return this.fail("float64", current, pos, end, path);
        }
        return [this.decodeFloat(current, pos, end, path), end];
      case "raw":
        return [b.slice(pos, end), end];
      case "any":
        return [this.decodeAny(pos, path), end];
      case "pointer":
        return this.decode(
          schema.elem,
          current ?? zeroValue(schema.elem),
          pos,
          path,
        );
      case "map":
        if (c !== 0x7b) return this.fail(schema.type, current, pos, end, path);
        return [this.decodeMap(schema, current, pos, path), end];
      case "slice":
        if (c !== 0x5b) return this.fail(schema.type, current, pos, end, path);
        return [this.decodeSlice(schema, current, pos, path), end];
      case "struct":
        if (c !== 0x7b) return this.fail(schema.type, current, pos, end, path);
        return [this.decodeStruct(schema, current, pos, path), end];
    }
  }

  // decodeAny decodes the value at pos into an interface{}. Objects and
  // arrays may nest 10000 deep, so it keeps them on its own stack.
  private decodeAny(pos: number, path: readonly string[]): AnyValue {
    const b = this.b;
    interface Frame {
      value: AnyValue[] | Map<string, AnyValue>;
      key: string;
    }
    const stack: Frame[] = [];
    const where = (): string[] => [
      ...path,
      ...stack.map((f) =>
        Array.isArray(f.value) ? String(f.value.length) : f.key,
      ),
    ];
    // name reads a member name and its colon; it returns the value start.
    const name = (n: number, f: Frame): number => {
      const end = stringEnd(b, n);
      f.key = unquote(b, n, end);
      return ws(b, ws(b, end) + 1);
    };
    let n = pos;
    for (;;) {
      const c = b[n] ?? 0;
      let v: AnyValue;
      if (c === 0x7b || c === 0x5b) {
        const f: Frame = {
          value: c === 0x7b ? new Map<string, AnyValue>() : [],
          key: "",
        };
        const first = ws(b, n + 1);
        if (b[first] !== c + 2) {
          stack.push(f);
          n = c === 0x7b ? name(first, f) : first;
          continue;
        }
        v = f.value;
        n = first + 1;
      } else {
        const end = skipValue(b, n);
        v = this.anyScalar(n, end, where());
        n = end;
      }
      // Add the finished value to its container; close what ends here.
      for (;;) {
        const top = stack.at(-1);
        if (!top) return v;
        if (Array.isArray(top.value)) top.value.push(v);
        else top.value.set(top.key, v);
        n = ws(b, n);
        if (b[n] === 0x2c) {
          n = ws(b, n + 1);
          if (!Array.isArray(top.value)) n = name(n, top);
          break;
        }
        stack.pop();
        v = top.value;
        n++;
      }
    }
  }

  private anyScalar(pos: number, end: number, path: string[]): AnyValue {
    const b = this.b;
    switch (b[pos]) {
      case 0x22:
        return unquote(b, pos, end);
      case 0x74:
        return true;
      case 0x66:
        return false;
      case 0x6e:
        return null;
    }
    const literal = text(b.subarray(pos, end));
    const f = Number(literal);
    if (!Number.isFinite(f))
      this.record("number " + literal, "float64", end, path);
    return f;
  }

  // decodeInt parses a number literal into an int64; any other literal,
  // such as 1.0 or 1e3, is a type error that names the literal.
  private decodeInt(
    current: Value,
    pos: number,
    end: number,
    path: readonly string[],
  ): Value {
    const literal = text(this.b.subarray(pos, end));
    if (/^-?(0|[1-9][0-9]*)$/.test(literal)) {
      const n = BigInt(literal);
      if (n >= int64Min && n <= int64Max) return n;
    }
    this.record("number " + literal, "int", end, path);
    return current;
  }

  // decodeFloat parses a number literal into a float64 (strconv.ParseFloat);
  // one out of its range is a type error that names the literal.
  private decodeFloat(
    current: Value,
    pos: number,
    end: number,
    path: readonly string[],
  ): Value {
    const literal = text(this.b.subarray(pos, end));
    const f = Number(literal);
    if (Number.isFinite(f)) return f;
    this.record("number " + literal, "float64", end, path);
    return current;
  }

  private decodeMap(
    schema: Extract<Schema, { kind: "map" }>,
    current: Value,
    pos: number,
    path: readonly string[],
  ): Value {
    const m =
      (current as Map<string, Value> | null) ?? new Map<string, Value>();
    this.members(pos, (name, valuePos) => {
      const [v, end] = this.decode(
        schema.elem,
        zeroValue(schema.elem),
        valuePos,
        [...path, name],
      );
      m.set(name, v);
      return end;
    });
    return m;
  }

  private decodeStruct(
    schema: Extract<Schema, { kind: "struct" }>,
    current: Value,
    pos: number,
    path: readonly string[],
  ): Value {
    const obj = current as Record<string, Value>;
    this.members(pos, (name, valuePos) => {
      const f =
        schema.fields.find((x) => x.name === name) ??
        schema.fields.find((x) => equalFold(name, x.name));
      if (!f) return skipValue(this.b, valuePos);
      const [v, end] = this.decode(f.schema, obj[f.name], valuePos, [
        ...path,
        name,
      ]);
      obj[f.name] = v;
      return end;
    });
    return obj;
  }

  private decodeSlice(
    schema: Extract<Schema, { kind: "slice" }>,
    current: Value,
    pos: number,
    path: readonly string[],
  ): Value {
    const b = this.b;
    const s = (current as GoSlice | null) ?? new GoSlice();
    let i = 0;
    let n = ws(b, pos + 1);
    if (b[n] !== 0x5d) {
      for (;;) {
        if (i === s.backing.length) {
          const cap = growCap(s.backing.length);
          while (s.backing.length < cap) s.backing.push(zeroValue(schema.elem));
        }
        const [v, end] = this.decode(schema.elem, s.backing[i], n, [
          ...path,
          String(i),
        ]);
        s.backing[i] = v;
        i++;
        n = ws(b, end);
        if (b[n] === 0x5d) break;
        n = ws(b, n + 1);
      }
    }
    if (i === 0) return new GoSlice();
    s.len = i;
    return s;
  }

  // members calls fn for each member of the object at pos with the
  // unquoted name and the position of the value; fn returns its end.
  private members(pos: number, fn: (name: string, valuePos: number) => number) {
    const b = this.b;
    let n = ws(b, pos + 1);
    if (b[n] === 0x7d) return;
    for (;;) {
      const nameEnd = stringEnd(b, n);
      const name = unquote(b, n, nameEnd);
      n = ws(b, nameEnd);
      n = ws(b, n + 1); // the colon
      n = ws(b, fn(name, n));
      if (b[n] === 0x7d) return;
      n = ws(b, n + 1); // the comma
    }
  }

  // fail records a value of the wrong JSON kind for type and keeps current.
  // The offset is the end of the value, or just past the opening bracket of
  // an object or array.
  private fail(
    type: string,
    current: Value,
    pos: number,
    end: number,
    path: readonly string[],
  ): [Value, number] {
    const c = this.b[pos] ?? 0;
    const offset = c === 0x7b || c === 0x5b ? pos + 1 : end;
    this.record(kindNames[c] ?? "number", type, offset, path);
    return [current, end];
  }

  private record(
    value: string,
    type: string,
    offset: number,
    path: readonly string[],
  ) {
    this.firstError ??= new UnmarshalTypeError(
      value,
      type,
      offset,
      path.map(escapePointerToken).join("."),
    );
  }
}

// growCap is the capacity Go gives a []string that grows past cap by one
// element (runtime.growslice, 16-byte elements).
function growCap(cap: number): number {
  const newLen = cap + 1;
  let newCap: number;
  const doubled = cap * 2;
  if (newLen > doubled) {
    newCap = newLen;
  } else if (cap < 256) {
    newCap = doubled;
  } else {
    newCap = cap;
    while (newCap < newLen) newCap += (newCap + 3 * 256) >> 2;
  }
  return roundUpSize(newCap * 16) / 16;
}

const sizeClasses = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240,
  256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024,
  1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864,
  5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568,
  14336, 16384, 18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768,
];

function roundUpSize(size: number): number {
  for (const c of sizeClasses) if (c >= size) return c;
  return Math.ceil(size / 8192) * 8192;
}

function escapePointerToken(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

// equalFold is strings.EqualFold for a JSON name against an ASCII field
// name: ASCII letters match in either case, and U+212A (Kelvin sign) and
// U+017F (long s) match k and s.
export function equalFold(name: string, field: string): boolean {
  // Code points, not UTF-16 units: one rune of the name per field byte.
  const a = Array.from(name);
  if (a.length !== field.length) return false;
  for (let i = 0; i < a.length; i++) {
    const r = a[i]?.codePointAt(0) ?? 0;
    const t = field.charCodeAt(i) | 0x20;
    const isLetter = t >= 0x61 && t <= 0x7a;
    if (r === field.charCodeAt(i)) continue;
    if (isLetter && (r | 0x20) === t && r < 0x80) continue;
    if (r === 0x212a && t === 0x6b) continue;
    if (r === 0x17f && t === 0x73) continue;
    return false;
  }
  return true;
}
