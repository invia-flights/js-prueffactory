// The decoder of gopkg.in/yaml.v3 v3.0.1 (decode.go): it turns a yaml.Node
// tree into a Go value of the type a Schema describes, with yaml.v3's rules
// for duplicate keys, merges, aliases, nulls and type errors.
//
// Values: Go string -> string, bool -> boolean, nil -> null, int -> bigint,
// uint64 -> GoUint64, float64 -> number, time.Time -> GoTime, []T -> array,
// map[string]T -> Map<string, T>, map[interface{}]T -> AnyMap, a struct ->
// a record keyed by its yaml names, a pointer -> the value or null.
//
// Copyright (c) 2011-2019 Canonical Ltd
// Apache License 2.0, see LICENSE in this folder.
import { formatFloatV, quote } from "../gocompat/fmt.ts";
import { compareBytes, utf8Bytes } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { GoTime } from "./gotime.ts";
import {
  binaryTag,
  GoUint64,
  mapTag,
  mergeTag,
  nullTag,
  resolve,
  ResolveError,
  type Resolved,
  seqTag,
  shortTag,
  strTag,
} from "./resolve.ts";
import {
  AliasNode,
  DocumentNode,
  failf,
  indicatedString,
  MappingNode,
  type Node,
  ScalarNode,
  SequenceNode,
  shortTagOf,
} from "./node.ts";

export { GoUint64 };

// AnyMap is a map[interface{}]interface{}: a mapping whose keys are not all
// strings.
export class AnyMap extends Map<unknown, unknown> {}

export interface Field {
  // The yaml name: the struct tag, or the lower-cased field name.
  readonly name: string;
  readonly schema: Schema;
}

// Schema describes the Go type a value is decoded into. type is the Go type
// as reflect.Type.String prints it, for the texts of type errors.
export type Schema =
  | { readonly kind: "any" }
  | { readonly kind: "string" }
  | { readonly kind: "bool" }
  | { readonly kind: "node" }
  | { readonly kind: "pointer"; readonly type: string; readonly elem: Schema }
  | {
      readonly kind: "map";
      readonly type: string;
      readonly key: Schema;
      readonly elem: Schema;
    }
  | { readonly kind: "slice"; readonly type: string; readonly elem: Schema }
  | {
      readonly kind: "struct";
      readonly type: string;
      readonly fields: readonly Field[];
    };

export type Value = unknown;

export const anySchema: Schema = { kind: "any" };
export const stringSchema: Schema = { kind: "string" };

const stringMapSchema: Schema = {
  kind: "map",
  type: "map[string]interface {}",
  key: stringSchema,
  elem: anySchema,
};
const generalMapSchema: Schema = {
  kind: "map",
  type: "map[interface {}]interface {}",
  key: anySchema,
  elem: anySchema,
};

function typeName(schema: Schema): string {
  switch (schema.kind) {
    case "any":
      return "interface {}";
    case "string":
      return "string";
    case "bool":
      return "bool";
    case "node":
      return "yaml.Node";
    default:
      return schema.type;
  }
}

const aliasRatioRangeLow = 400000;
const aliasRatioRangeHigh = 4000000;
const aliasRatioRange = aliasRatioRangeHigh - aliasRatioRangeLow;

function allowedAliasRatio(decodeCount: number): number {
  if (decodeCount <= aliasRatioRangeLow) return 0.99;
  if (decodeCount >= aliasRatioRangeHigh) return 0.1;
  return 0.99 - 0.89 * ((decodeCount - aliasRatioRangeLow) / aliasRatioRange);
}

function isMerge(n: Node): boolean {
  return (
    n.kind === ScalarNode &&
    n.value === "<<" &&
    (n.tag === "" || n.tag === "!" || shortTag(n.tag) === mergeTag)
  );
}

function isStringMap(n: Node): boolean {
  if (n.kind !== MappingNode) return false;
  for (let i = 0; i < n.content.length; i += 2) {
    const k = n.content[i];
    if (!k) continue;
    const t = shortTagOf(k);
    if (t !== strTag && t !== mergeTag) return false;
  }
  return true;
}

// decodeBase64 is base64.StdEncoding.DecodeString, which skips \r and \n.
function decodeBase64(s: string): string | null {
  const t = s.replace(/[\r\n]/g, "");
  if (
    t.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t)
  ) {
    return null;
  }
  return goString(Buffer.from(t, "base64"));
}

type Result = [Value, boolean];
// A Request asks the decode loop to decode a node into a schema from a value.
type Request = [Node, Schema, Value];
type Step = Generator<Request, Result, Result>;

export class Decoder {
  terrors: string[] = [];
  private readonly aliases = new Set<Node>();
  private decodeCount = 0;
  private aliasCount = 0;
  private aliasDepth = 0;
  private mergedFields: Map<unknown, boolean> | null = null;
  readonly uniqueKeys: boolean = true;

  zero(schema: Schema): Value {
    switch (schema.kind) {
      case "string":
        return "";
      case "bool":
        return false;
      case "struct": {
        const out: Record<string, Value> = {};
        for (const f of schema.fields) out[f.name] = this.zero(f.schema);
        return out;
      }
      default:
        return null;
    }
  }

  private terror(n: Node, tag0: string, schema: Schema): void {
    const tag = n.tag !== "" ? n.tag : tag0;
    let value = "";
    if (tag !== seqTag && tag !== mapTag) {
      const b = utf8Bytes(n.value);
      value =
        b.length > 10
          ? " `" + goString(b.subarray(0, 7)) + "...`"
          : " `" + n.value + "`";
    }
    this.terrors.push(
      `line ${String(n.line)}: cannot unmarshal ${shortTag(tag)}${value} into ${typeName(schema)}`,
    );
  }

  // unmarshal decodes n into a value of schema, starting from cur. Go
  // recurses once per nesting level; the steps here are generators that ask
  // this loop for each child, so the JavaScript stack stays flat.
  unmarshal(n: Node, schema: Schema, cur: Value): Result {
    const stack: Step[] = [this.step(n, schema, cur)];
    let input: Result = [cur, false];
    for (;;) {
      const top = stack.at(-1);
      if (!top) return input;
      const r = top.next(input);
      if (r.done) {
        stack.pop();
        input = r.value;
      } else {
        const [cn, cs, cc] = r.value;
        stack.push(this.step(cn, cs, cc));
      }
    }
  }

  private *step(n: Node, schema: Schema, cur: Value): Step {
    this.decodeCount++;
    if (this.aliasDepth > 0) this.aliasCount++;
    if (
      this.aliasCount > 100 &&
      this.decodeCount > 1000 &&
      this.aliasCount / this.decodeCount > allowedAliasRatio(this.decodeCount)
    ) {
      failf("document contains excessive aliasing");
    }
    if (schema.kind === "node") return [n, true];
    if (n.kind === DocumentNode) return yield* this.document(n, schema, cur);
    if (n.kind === AliasNode) return yield* this.alias(n, schema, cur);
    return yield* this.prepared(n, schema, cur);
  }

  // prepared follows pointers (allocating them) unless the node is null,
  // then decodes by node kind.
  private *prepared(n: Node, schema0: Schema, cur0: Value): Step {
    let schema = schema0;
    let cur = cur0;
    while (schema.kind === "pointer" && shortTagOf(n) !== nullTag) {
      cur = cur ?? this.zero(schema.elem);
      schema = schema.elem;
    }
    switch (n.kind) {
      case ScalarNode:
        return this.scalar(n, schema, cur);
      case MappingNode:
        return yield* this.mapping(n, schema, cur);
      case SequenceNode:
        return yield* this.sequence(n, schema, cur);
      default:
        return failf(`cannot decode node with unknown kind ${String(n.kind)}`);
    }
  }

  private *document(n: Node, schema: Schema, cur: Value): Step {
    const only = n.content.length === 1 ? n.content[0] : undefined;
    if (only) {
      const [v] = yield [only, schema, cur];
      return [v, true];
    }
    return [cur, false];
  }

  private *alias(n: Node, schema: Schema, cur: Value): Step {
    if (this.aliases.has(n)) {
      failf(`anchor '${n.value}' value contains itself`);
    }
    this.aliases.add(n);
    this.aliasDepth++;
    const target = n.alias;
    if (!target) throw new Error("yaml: alias without a target");
    const r = yield [target, schema, cur];
    this.aliasDepth--;
    this.aliases.delete(n);
    return r;
  }

  private null(schema: Schema, cur: Value): Result {
    switch (schema.kind) {
      case "any":
      case "pointer":
      case "map":
      case "slice":
        return [null, true];
      default:
        return [cur, false];
    }
  }

  private scalar(n: Node, schema: Schema, cur: Value): Result {
    let tag: string;
    let resolved: Resolved;
    if (indicatedString(n)) {
      tag = strTag;
      resolved = n.value;
    } else {
      try {
        [tag, resolved] = resolve(n.tag, n.value);
      } catch (e) {
        if (e instanceof ResolveError) failf(e.message);
        throw e;
      }
      if (tag === binaryTag) {
        const data = decodeBase64(resolved as string);
        if (data === null) failf("!!binary value contains invalid base64 data");
        resolved = data;
      }
    }
    if (resolved === null) return this.null(schema, cur);
    switch (schema.kind) {
      case "string":
        if (typeof resolved === "string") return [resolved, true];
        return [n.value, true];
      case "any":
        return [resolved, true];
      case "bool":
        if (typeof resolved === "boolean") return [resolved, true];
        if (typeof resolved === "string") {
          if (
            ["y", "Y", "yes", "Yes", "YES", "on", "On", "ON"].includes(resolved)
          ) {
            return [true, true];
          }
          if (
            ["n", "N", "no", "No", "NO", "off", "Off", "OFF"].includes(resolved)
          ) {
            return [false, true];
          }
        }
        break;
      default:
        break;
    }
    this.terror(n, tag, schema);
    return [cur, false];
  }

  private *sequence(n: Node, schema: Schema, cur: Value): Step {
    let elem: Schema;
    switch (schema.kind) {
      case "slice":
        elem = schema.elem;
        break;
      case "any":
        elem = anySchema;
        break;
      default:
        this.terror(n, seqTag, schema);
        return [cur, false];
    }
    const out: Value[] = [];
    for (const item of n.content) {
      const [v, ok] = yield [item, elem, this.zero(elem)];
      if (ok) out.push(v);
    }
    return [out, true];
  }

  private *mapping(n: Node, schema0: Schema, cur0: Value): Step {
    const l = n.content.length;
    if (this.uniqueKeys) {
      const nerrs = this.terrors.length;
      for (let i = 0; i < l; i += 2) {
        const ni = n.content[i];
        if (!ni) continue;
        for (let j = i + 2; j < l; j += 2) {
          const nj = n.content[j];
          if (nj?.kind === ni.kind && nj.value === ni.value) {
            this.terrors.push(
              `line ${String(nj.line)}: mapping key ${quote(nj.value)} already defined at line ${String(ni.line)}`,
            );
          }
        }
      }
      if (this.terrors.length > nerrs) return [cur0, false];
    }
    let schema = schema0;
    let cur = cur0;
    let mapIsNew = false;
    switch (schema.kind) {
      case "struct":
        return yield* this.mappingStruct(n, schema, cur);
      case "map":
        if (cur === null) {
          cur = schema.key.kind === "any" ? new AnyMap() : new Map();
          mapIsNew = true;
        }
        break;
      case "any":
        if (isStringMap(n)) {
          schema = stringMapSchema;
          cur = new Map<string, Value>();
        } else {
          schema = generalMapSchema;
          cur = new AnyMap();
        }
        break;
      default:
        this.terror(n, mapTag, schema);
        return [cur, false];
    }
    const mapSchema = schema as Extract<Schema, { kind: "map" }>;
    const out = cur as Map<unknown, Value>;
    const key = mapSchema.key;
    const elem = mapSchema.elem;

    const mergedFields = this.mergedFields;
    this.mergedFields = null;
    let mergeNode: Node | null = null;

    for (let i = 0; i < l; i += 2) {
      const kn = n.content[i];
      const vn = n.content[i + 1];
      if (!kn || !vn) continue;
      if (isMerge(kn)) {
        mergeNode = vn;
        continue;
      }
      const [k, ok] = yield [kn, key, this.zero(key)];
      if (!ok) continue;
      if (mergedFields !== null) {
        if (mergedFields.has(k)) continue;
        mergedFields.set(k, true);
      }
      if (k instanceof Map || Array.isArray(k)) {
        failf(`invalid map key: ${goSyntax(k)}`);
      }
      const [e, eok] = yield [vn, elem, this.zero(elem)];
      if (eok || (shortTagOf(vn) === nullTag && (mapIsNew || !out.has(k)))) {
        out.set(k, e);
      }
    }

    this.mergedFields = mergedFields;
    if (mergeNode !== null) yield* this.merge(n, mergeNode, schema, out);
    return [out, true];
  }

  private *mappingStruct(
    n: Node,
    schema: Extract<Schema, { kind: "struct" }>,
    cur: Value,
  ): Step {
    const rec = cur as Record<string, Value>;
    const mergedFields = this.mergedFields;
    this.mergedFields = null;
    let mergeNode: Node | null = null;
    const done = new Set<string>();
    for (let i = 0; i < n.content.length; i += 2) {
      const ni = n.content[i];
      const vi = n.content[i + 1];
      if (!ni || !vi) continue;
      if (isMerge(ni)) {
        mergeNode = vi;
        continue;
      }
      const [nameValue, ok] = yield [ni, stringSchema, ""];
      if (!ok) continue;
      const name = nameValue as string;
      if (mergedFields !== null) {
        if (mergedFields.has(name)) continue;
        mergedFields.set(name, true);
      }
      const field = schema.fields.find((f) => f.name === name);
      if (field) {
        if (this.uniqueKeys) {
          if (done.has(name)) {
            this.terrors.push(
              `line ${String(ni.line)}: field ${name} already set in type ${schema.type}`,
            );
            continue;
          }
          done.add(name);
        }
        rec[name] = (yield [vi, field.schema, rec[name]])[0];
      }
    }
    this.mergedFields = mergedFields;
    if (mergeNode !== null) yield* this.merge(n, mergeNode, schema, rec);
    return [rec, true];
  }

  private *merge(
    parent: Node,
    merge: Node,
    schema: Schema,
    out: Value,
  ): Generator<Request, void, Result> {
    const mergedFields = this.mergedFields;
    if (mergedFields === null) {
      this.mergedFields = new Map();
      for (let i = 0; i < parent.content.length; i += 2) {
        const kn = parent.content[i];
        if (!kn) continue;
        const [k, ok] = yield [kn, anySchema, null];
        if (ok) this.mergedFields.set(k, true);
      }
    }
    const wantMap = () =>
      failf("map merge requires map or sequence of maps as the value");
    switch (merge.kind) {
      case MappingNode:
        yield [merge, schema, out];
        break;
      case AliasNode:
        if (merge.alias && merge.alias.kind !== MappingNode) wantMap();
        yield [merge, schema, out];
        break;
      case SequenceNode:
        for (const ni of merge.content) {
          if (ni.kind === AliasNode) {
            if (ni.alias && ni.alias.kind !== MappingNode) wantMap();
          } else if (ni.kind !== MappingNode) {
            wantMap();
          }
          yield [ni, schema, out];
        }
        break;
      default:
        wantMap();
    }
    this.mergedFields = mergedFields;
  }
}

// sprint is fmt.Sprint of a decoded value (%v).
export function sprint(v: Value): string {
  if (v === null || v === undefined) return "<nil>";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return formatFloatV(v);
  if (v instanceof GoUint64) return v.value.toString();
  if (v instanceof GoTime) return v.string();
  if (Array.isArray(v)) return "[" + v.map(sprint).join(" ") + "]";
  if (v instanceof Map) {
    const entries = [...(v as Map<unknown, unknown>)].map(
      ([k, e]) => [sprint(k), sprint(e)] as const,
    );
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    return "map[" + entries.map(([k, e]) => `${k}:${e}`).join(" ") + "]";
  }
  throw new Error("yaml: sprint of an unknown value");
}

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// goSyntax is fmt's %#v of a decoded value, as yaml.v3 prints an invalid
// map key.
export function goSyntax(v: Value, inInterface = false): string {
  if (v === null || v === undefined) {
    return inInterface ? "interface {}(nil)" : "<nil>";
  }
  if (typeof v === "string") return quote(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return formatFloatV(v);
  if (v instanceof GoUint64) return "0x" + v.value.toString(16);
  if (v instanceof GoTime) {
    const loc = v.offset === null ? "time.UTC" : 'time.Location("")';
    return `time.Date(${String(v.year)}, time.${monthNames[v.month - 1] ?? ""}, ${String(v.day)}, ${String(v.hour)}, ${String(v.minute)}, ${String(v.second)}, ${String(v.nanosecond)}, ${loc})`;
  }
  if (Array.isArray(v)) {
    return "[]interface {}{" + v.map((e) => goSyntax(e, true)).join(", ") + "}";
  }
  if (v instanceof Map) {
    const general = v instanceof AnyMap;
    const entries = [...(v as Map<unknown, unknown>)].map(
      ([k, e]) => [goSyntax(k, general), goSyntax(e, true)] as const,
    );
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    const type = general
      ? "map[interface {}]interface {}"
      : "map[string]interface {}";
    return type + "{" + entries.map(([k, e]) => `${k}:${e}`).join(", ") + "}";
  }
  throw new Error("yaml: goSyntax of an unknown value");
}
