// A port of the draft-07 validation of santhosh-tekuri/jsonschema v6.0.3
// (validator.go, kind/kind.go), the library the Go build validated GitLab CI
// files with. It gives the same error tree: the same causes in the same
// order, with the same instance locations, keyword paths and English texts,
// so that what the Check makes of the tree (the deepest branches of anyOf
// and oneOf, one message list per instance) matches the Go build.
//
// Covered: every draft-07 keyword but the content* annotations, with local
// $ref ("#/..."). Not covered: other drafts, remote references, $ref cycles
// that never reach a value (the Go library reports those as an error; a
// schema with one is a bug the port's tests would show).
//
// Values are what a parsed document holds: null, boolean, string, number
// (Go's float64), bigint (Go's int, int64 and uint64), arrays and
// Map<string, Value> (map[string]any). Map order is the document's order;
// Go iterates its maps in random order, which shows only in the order of
// the names of one additionalProperties error.
import { formatFloatV } from "../gocompat/fmt.ts";
import { englishFloat, englishInt, goQuote } from "../schema/validator.ts";
import { formats } from "./format.ts";
import { re2 } from "../gocompat/regexp.ts";

export type Value =
  | null
  | boolean
  | string
  | number
  | bigint
  | Value[]
  | Map<string, Value>;

/** ValidationError is one node of the error tree. */
export interface ValidationError {
  /** instanceLocation holds the unescaped JSON pointer tokens of the value. */
  readonly instanceLocation: readonly string[];
  readonly kind: ErrorKind;
  readonly causes: ValidationError[];
}

/** ErrorKind is the kind of an error: its keyword path and its text. */
export interface ErrorKind {
  /** name is the Go kind type: "Type", "AnyOf", "OneOf", "Group", ... */
  readonly name: string;
  readonly keywordPath: readonly string[];
  readonly message: string;
}

// --- compiled schemas ---

type Additional = boolean | Schema | null;

interface Schema {
  bool: boolean | null;
  ref: Schema | null;
  types: string[] | null;
  enum: Value[] | null;
  const: { value: Value } | null;
  format: { name: string; check: (s: string) => string | undefined } | null;
  not: Schema | null;
  allOf: Schema[];
  anyOf: Schema[];
  oneOf: Schema[];
  if: Schema | null;
  then: Schema | null;
  else: Schema | null;
  // object
  minProperties: number | null;
  maxProperties: number | null;
  required: string[];
  dependencies: [string, string[] | Schema][];
  properties: Map<string, Schema>;
  patternProperties: [RegExp, Schema][];
  additionalProperties: Additional;
  propertyNames: Schema | null;
  // array
  minItems: number | null;
  maxItems: number | null;
  uniqueItems: boolean;
  items: Schema | Schema[] | null;
  additionalItems: Additional;
  contains: Schema | null;
  // string
  minLength: number | null;
  maxLength: number | null;
  pattern: { source: string; re: RegExp } | null;
  // number
  minimum: Rat | null;
  maximum: Rat | null;
  exclusiveMinimum: Rat | null;
  exclusiveMaximum: Rat | null;
  multipleOf: Rat | null;
}

type JSONDoc = unknown;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unescapeToken(t: string): string {
  return t.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** CompiledSchema validates values against a compiled draft-07 schema. */
export class CompiledSchema {
  readonly #root: Schema;
  constructor(root: Schema) {
    this.#root = root;
  }

  /**
   * validate returns the error tree, or null when the value is valid. Its
   * root is the library's kind.Schema error with the failures as causes.
   */
  validate(v: Value): ValidationError | null {
    const vd = new Validator(v, [], this.#root, false);
    const err = vd.validate();
    if (err === null) return null;
    return {
      instanceLocation: [],
      kind: { name: "Schema", keywordPath: [], message: "jsonschema validation failed" },
      causes: err.kind.name === "Group" ? err.causes : [err],
    };
  }
}

/**
 * compile compiles a draft-07 schema document (parsed JSON). Only local
 * references ("#/...") resolve; any other throws, as the Go build's loader
 * refused every load.
 */
export function compile(doc: JSONDoc): CompiledSchema {
  const compiled = new Map<string, Schema>();
  const resolve = (pointer: string): unknown => {
    let node: unknown = doc;
    if (pointer === "") return node;
    for (const raw of pointer.slice(1).split("/")) {
      const tok = unescapeToken(decodeURIComponent(raw));
      if (Array.isArray(node)) node = node[Number(tok)];
      else if (isObject(node)) node = node[tok];
      else node = undefined;
      if (node === undefined) {
        throw new Error(`json-pointer ${pointer} not found`);
      }
    }
    return node;
  };
  const at = (pointer: string): Schema => {
    const done = compiled.get(pointer);
    if (done) return done;
    const s = emptySchema();
    compiled.set(pointer, s);
    fill(s, resolve(pointer), pointer);
    return s;
  };
  const fill = (s: Schema, node: unknown, ptr: string): void => {
    if (typeof node === "boolean") {
      s.bool = node;
      return;
    }
    if (!isObject(node)) {
      throw new Error(`schema at ${ptr} is not an object`);
    }
    const child = (...toks: string[]): string =>
      ptr + toks.map((t) => "/" + t.replaceAll("~", "~0").replaceAll("/", "~1")).join("");
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#")) {
        throw new Error(`the schema must not load ${ref}`);
      }
      s.ref = at(ref.slice(1));
      return; // draft-07: every other keyword of a $ref object is ignored
    }
    const list = (key: string): Schema[] =>
      Array.isArray(node[key]) ? (node[key] as unknown[]).map((_, i) => at(child(key, String(i)))) : [];
    const one = (key: string): Schema | null => (key in node ? at(child(key)) : null);
    const additional = (key: string): Additional => {
      const v = node[key];
      if (v === undefined) return null;
      if (typeof v === "boolean") return v;
      return at(child(key));
    };
    const num = (key: string): number | null => (typeof node[key] === "number" ? node[key] : null);
    const rat = (key: string): Rat | null => (typeof node[key] === "number" ? ratOf(node[key]) : null);

    s.allOf = list("allOf");
    s.anyOf = list("anyOf");
    s.oneOf = list("oneOf");
    s.not = one("not");
    if (Array.isArray(node.items)) {
      s.items = list("items");
      s.additionalItems = additional("additionalItems");
    } else if ("items" in node) {
      s.items = at(child("items"));
    }
    if (isObject(node.properties)) {
      for (const name of Object.keys(node.properties)) {
        s.properties.set(name, at(child("properties", name)));
      }
    }
    if (isObject(node.patternProperties)) {
      for (const p of Object.keys(node.patternProperties)) {
        s.patternProperties.push([re2(p), at(child("patternProperties", p))]);
      }
    }
    s.additionalProperties = additional("additionalProperties");
    if (isObject(node.dependencies)) {
      for (const [name, dep] of Object.entries(node.dependencies)) {
        s.dependencies.push([
          name,
          Array.isArray(dep) ? dep.map(String) : at(child("dependencies", name)),
        ]);
      }
    }
    if (typeof node.type === "string") s.types = [node.type];
    else if (Array.isArray(node.type)) s.types = node.type.map(String);
    if (Array.isArray(node.enum)) s.enum = node.enum.map(toValue);
    if (Array.isArray(node.required)) s.required = node.required.map(String);
    s.minProperties = num("minProperties");
    s.maxProperties = num("maxProperties");
    s.minItems = num("minItems");
    s.maxItems = num("maxItems");
    s.uniqueItems = node.uniqueItems === true;
    s.minLength = num("minLength");
    s.maxLength = num("maxLength");
    if (typeof node.pattern === "string") {
      s.pattern = { source: node.pattern, re: re2(node.pattern) };
    }
    s.minimum = rat("minimum");
    s.maximum = rat("maximum");
    s.multipleOf = rat("multipleOf");
    // draft-06 on
    if ("const" in node) s.const = { value: toValue(node.const) };
    s.contains = one("contains");
    s.propertyNames = one("propertyNames");
    s.exclusiveMinimum = rat("exclusiveMinimum");
    s.exclusiveMaximum = rat("exclusiveMaximum");
    // draft-07: format is asserted
    if (typeof node.format === "string") {
      const check = formats[node.format];
      if (check !== undefined) {
        s.format = { name: node.format, check };
      }
    }
    if ("if" in node) {
      s.if = one("if");
      s.then = one("then");
      s.else = one("else");
    }
  };
  return new CompiledSchema(at(""));
}

function emptySchema(): Schema {
  return {
    bool: null,
    ref: null,
    types: null,
    enum: null,
    const: null,
    format: null,
    not: null,
    allOf: [],
    anyOf: [],
    oneOf: [],
    if: null,
    then: null,
    else: null,
    minProperties: null,
    maxProperties: null,
    required: [],
    dependencies: [],
    properties: new Map(),
    patternProperties: [],
    additionalProperties: null,
    propertyNames: null,
    minItems: null,
    maxItems: null,
    uniqueItems: false,
    items: null,
    additionalItems: null,
    contains: null,
    minLength: null,
    maxLength: null,
    pattern: null,
    minimum: null,
    maximum: null,
    exclusiveMinimum: null,
    exclusiveMaximum: null,
    multipleOf: null,
  };
}

/** toValue turns parsed JSON (objects as records) into a Value. */
export function toValue(v: unknown): Value {
  if (Array.isArray(v)) return v.map(toValue);
  if (isObject(v)) {
    return new Map(Object.entries(v).map(([k, x]) => [k, toValue(x)]));
  }
  return v as Value;
}

// --- numbers as exact rationals (Go: big.Rat of fmt.Sprint(v)) ---

interface Rat {
  num: bigint;
  den: bigint;
}

function ratOf(v: number | bigint): Rat {
  if (typeof v === "bigint") return { num: v, den: 1n };
  // The shortest decimal form, as fmt.Sprint writes it, read exactly.
  const [mant = "", expText = "0"] = v.toExponential().split("e");
  const negative = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  const frac = (mant.split(".")[1] ?? "").length;
  const exp = Number(expText) - frac;
  let num = BigInt(digits);
  let den = 1n;
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den = 10n ** BigInt(-exp);
  return { num: negative ? -num : num, den };
}

function cmp(a: Rat, b: Rat): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

function ratFloat(r: Rat): number {
  return Number(r.num) / Number(r.den);
}

// --- value helpers ---

type JSONType =
  | "null"
  | "boolean"
  | "number"
  | "integer"
  | "string"
  | "array"
  | "object";

const typeOrder: JSONType[] = [
  "null",
  "boolean",
  "number",
  "integer",
  "string",
  "array",
  "object",
];

function typeOf(v: Value): JSONType | "invalid" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "object";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "bigint":
      return "number";
    case "number":
      return Number.isFinite(v) ? "number" : "invalid";
  }
  return "invalid";
}

function isInteger(v: number | bigint): boolean {
  return typeof v === "bigint" || Number.isInteger(v);
}

function equals(a: Value, b: Value): boolean {
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, x] of a) {
      if (!b.has(k)) return false;
      if (!equals(x, b.get(k) ?? null)) return false;
    }
    return true;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equals(x, b[i] ?? null));
  }
  if (typeof a === "number" || typeof a === "bigint") {
    if (typeof b !== "number" && typeof b !== "bigint") return false;
    return cmp(ratOf(a), ratOf(b)) === 0;
  }
  return a === b;
}

/** display is the library's display: %v, quoted strings, "value" for lists and maps. */
function display(v: Value): string {
  if (typeof v === "string") return goQuote(v);
  if (Array.isArray(v) || v instanceof Map) return "value";
  if (v === null) return "<nil>";
  if (typeof v === "number") return formatFloatV(v);
  return String(v);
}

function joinQuoted(list: readonly string[]): string {
  return list.map(goQuote).join(", ");
}

function kind(name: string, keywordPath: string[], message: string): ErrorKind {
  return { name, keywordPath, message };
}

// --- the validator ---

class Validator {
  readonly v: Value;
  readonly vloc: string[];
  readonly sch: Schema;
  readonly boolResult: boolean;
  errors: ValidationError[] = [];

  constructor(v: Value, vloc: string[], sch: Schema, boolResult: boolean) {
    this.v = v;
    this.vloc = vloc;
    this.sch = sch;
    this.boolResult = boolResult;
  }

  error(k: () => ErrorKind): ValidationError {
    if (this.boolResult) {
      return { instanceLocation: [], kind: emptyKind, causes: [] };
    }
    return { instanceLocation: this.vloc, kind: k(), causes: [] };
  }

  addErr(err: ValidationError | null): void {
    if (err !== null) this.errors.push(err);
  }

  addError(k: () => ErrorKind): void {
    this.errors.push(this.error(k));
  }

  addErrors(errors: ValidationError[], k: () => ErrorKind): void {
    const err = this.error(k);
    this.errors.push({ ...err, causes: errors });
  }

  validateSelf(sch: Schema, boolResult: boolean): ValidationError | null {
    return new Validator(this.v, this.vloc, sch, this.boolResult || boolResult).validate();
  }

  validateVal(sch: Schema, v: Value, tok: string): ValidationError | null {
    return new Validator(v, [...this.vloc, tok], sch, this.boolResult).validate();
  }

  validate(): ValidationError | null {
    const s = this.sch;
    const v = this.v;
    if (s.bool !== null) {
      return s.bool ? null : this.error(() => kind("FalseSchema", [], "false schema"));
    }
    const t = typeOf(v);
    if (t === "invalid") {
      return this.error(() => kind("InvalidJsonValue", [], "invalid jsonType float64"));
    }
    if (s.types !== null && s.types.length > 0) {
      const matched =
        s.types.includes(t) ||
        (s.types.includes("integer") && t === "number" && isInteger(v as number | bigint));
      if (!matched) {
        const want = typeOrder.filter((x) => s.types?.includes(x));
        return this.error(() => kind("Type", ["type"], `got ${t}, want ${want.join(" or ")}`));
      }
    }
    if (s.const !== null) {
      const want = s.const.value;
      if (!equals(v, want)) {
        return this.error(() =>
          kind(
            "Const",
            ["const"],
            Array.isArray(want) || want instanceof Map ? "'const' failed" : `value must be ${display(want)}`,
          ),
        );
      }
    }
    if (s.enum !== null) {
      const values = s.enum;
      const types = new Set(values.map(typeOf));
      const matched = types.has(t) && values.some((x) => equals(v, x));
      if (!matched) {
        return this.error(() => {
          const primitive = values.every((x) => !Array.isArray(x) && !(x instanceof Map));
          let message = "'enum' failed";
          if (primitive) {
            message =
              values.length === 1
                ? `value must be ${display(values[0] ?? null)}`
                : `value must be one of ${values.map(display).join(", ")}`;
          }
          return kind("Enum", ["enum"], message);
        });
      }
    }
    if (s.format !== null && typeof v === "string") {
      const reason = s.format.check(v);
      if (reason !== undefined) {
        const name = s.format.name;
        return this.error(() => kind("Format", ["format"], `${display(v)} is not valid ${name}: ${reason}`));
      }
    }
    if (s.ref !== null) {
      // draft-07: the reference is all there is.
      return this.validateRef(s.ref);
    }
    if (v instanceof Map) this.objValidate(v);
    else if (Array.isArray(v)) this.arrValidate(v);
    else if (typeof v === "string") this.strValidate(v);
    else if (typeof v === "number" || typeof v === "bigint") this.numValidate(v);

    if (this.errors.length === 0 || !this.boolResult) {
      this.condValidate();
    }
    switch (this.errors.length) {
      case 0:
        return null;
      case 1:
        return this.errors[0] ?? null;
      default: {
        const err = this.error(() => kind("Group", [], "validation failed"));
        return { ...err, causes: this.errors };
      }
    }
  }

  validateRef(sch: Schema): ValidationError | null {
    const err = this.validateSelf(sch, false);
    if (err === null) return null;
    const refErr = this.error(() => kind("Reference", ["$ref"], "validation failed"));
    return { ...refErr, causes: err.kind.name === "Group" ? err.causes : [err] };
  }

  findMissing(obj: Map<string, Value>, required: readonly string[]): string[] | null {
    const missing: string[] = [];
    for (const name of required) {
      if (!obj.has(name)) {
        if (this.boolResult) return [];
        missing.push(name);
      }
    }
    return missing.length > 0 ? missing : null;
  }

  objValidate(obj: Map<string, Value>): void {
    const s = this.sch;
    if (s.minProperties !== null && obj.size < s.minProperties) {
      const want = s.minProperties;
      this.addError(() => kind("MinProperties", ["minProperties"], `minProperties: got ${englishInt(obj.size)}, want ${englishInt(want)}`));
    }
    if (s.maxProperties !== null && obj.size > s.maxProperties) {
      const want = s.maxProperties;
      this.addError(() => kind("MaxProperties", ["maxProperties"], `maxProperties: got ${englishInt(obj.size)}, want ${englishInt(want)}`));
    }
    if (s.required.length > 0) {
      const missing = this.findMissing(obj, s.required);
      if (missing !== null) {
        this.addError(() =>
          kind(
            "Required",
            ["required"],
            missing.length === 1 ? `missing property ${goQuote(missing[0] ?? "")}` : `missing properties ${joinQuoted(missing)}`,
          ),
        );
      }
    }
    if (this.boolResult && this.errors.length > 0) return;

    for (const [name, dep] of s.dependencies) {
      if (!obj.has(name)) continue;
      if (Array.isArray(dep)) {
        const missing = this.findMissing(obj, dep);
        if (missing !== null) {
          this.addError(() =>
            kind("Dependency", ["dependency", name], `properties ${joinQuoted(missing)} required, if ${goQuote(name)} exists`),
          );
        }
      } else {
        this.addErr(this.validateSelf(dep, false));
      }
    }

    const additional: string[] = [];
    for (const [name, value] of obj) {
      if (this.boolResult && this.errors.length > 0) return;
      let evaluated = false;
      const prop = s.properties.get(name);
      if (prop !== undefined) {
        evaluated = true;
        this.addErr(this.validateVal(prop, value, name));
      }
      for (const [re, sch] of s.patternProperties) {
        if (re.test(name)) {
          evaluated = true;
          this.addErr(this.validateVal(sch, value, name));
        }
      }
      if (!evaluated && s.additionalProperties !== null) {
        if (s.additionalProperties === false) {
          additional.push(name);
        } else if (s.additionalProperties !== true) {
          this.addErr(this.validateVal(s.additionalProperties, value, name));
        }
      }
    }
    if (additional.length > 0) {
      this.addError(() =>
        kind("AdditionalProperties", ["additionalProperties"], `additional properties ${joinQuoted(additional)} not allowed`),
      );
    }

    if (s.propertyNames !== null) {
      for (const name of obj.keys()) {
        const err = new Validator(name, [], s.propertyNames, this.boolResult).validate();
        if (err !== null) {
          const e = this.error(() => kind("PropertyNames", ["propertyNames"], `invalid propertyName ${goQuote(name)}`));
          this.errors.push({ ...e, causes: err.kind.name === "Group" ? err.causes : [err] });
        }
      }
    }
  }

  arrValidate(arr: Value[]): void {
    const s = this.sch;
    if (s.minItems !== null && arr.length < s.minItems) {
      const want = s.minItems;
      this.addError(() => kind("MinItems", ["minItems"], `minItems: got ${englishInt(arr.length)}, want ${englishInt(want)}`));
    }
    if (s.maxItems !== null && arr.length > s.maxItems) {
      const want = s.maxItems;
      this.addError(() => kind("MaxItems", ["maxItems"], `maxItems: got ${englishInt(arr.length)}, want ${englishInt(want)}`));
    }
    if (s.uniqueItems && arr.length > 1) {
      const dup = duplicates(arr);
      if (dup !== null) {
        const [i, j] = dup;
        this.addError(() => kind("UniqueItems", ["uniqueItems"], `items at ${englishInt(i)} and ${englishInt(j)} are equal`));
      }
    }
    let evaluated = 0;
    if (Array.isArray(s.items)) {
      const n = Math.min(arr.length, s.items.length);
      for (let i = 0; i < n; i++) {
        this.addErr(this.validateVal(s.items[i] as Schema, arr[i] ?? null, String(i)));
      }
      evaluated = n;
    } else if (s.items !== null) {
      for (let i = 0; i < arr.length; i++) {
        this.addErr(this.validateVal(s.items, arr[i] ?? null, String(i)));
      }
      evaluated = arr.length;
    }
    if (s.additionalItems !== null) {
      if (s.additionalItems === false) {
        if (evaluated !== arr.length) {
          const count = arr.length - evaluated;
          this.addError(() => kind("AdditionalItems", ["additionalItems"], `last ${englishInt(count)} additionalItem(s) not allowed`));
        }
      } else if (s.additionalItems !== true) {
        for (let i = evaluated; i < arr.length; i++) {
          this.addErr(this.validateVal(s.additionalItems, arr[i] ?? null, String(i)));
        }
      }
    }
    if (s.contains !== null) {
      const errors: ValidationError[] = [];
      let matched = 0;
      for (let i = 0; i < arr.length; i++) {
        const err = this.validateVal(s.contains, arr[i] ?? null, String(i));
        if (err !== null) errors.push(err);
        else matched++;
      }
      if (matched === 0) {
        this.addErrors(errors, () => kind("Contains", ["contains"], "no items match contains schema"));
      }
    }
  }

  strValidate(str: string): void {
    const s = this.sch;
    let length = -1;
    if (s.minLength !== null || s.maxLength !== null) {
      length = Array.from(str).length;
    }
    if (s.minLength !== null && length < s.minLength) {
      const want = s.minLength;
      this.addError(() => kind("MinLength", ["minLength"], `minLength: got ${englishInt(length)}, want ${englishInt(want)}`));
    }
    if (s.maxLength !== null && length > s.maxLength) {
      const want = s.maxLength;
      this.addError(() => kind("MaxLength", ["maxLength"], `maxLength: got ${englishInt(length)}, want ${englishInt(want)}`));
    }
    if (s.pattern !== null && !s.pattern.re.test(str)) {
      const want = s.pattern.source;
      this.addError(() => kind("Pattern", ["pattern"], `${goQuote(str)} does not match pattern ${goQuote(want)}`));
    }
  }

  numValidate(v: number | bigint): void {
    const s = this.sch;
    const num = ratOf(v);
    const check = (name: string, want: Rat | null, fails: (c: number) => boolean): void => {
      if (want !== null && fails(cmp(num, want))) {
        this.addError(() =>
          kind(name[0]?.toUpperCase() + name.slice(1), [name], `${name}: got ${englishFloat(ratFloat(num))}, want ${englishFloat(ratFloat(want))}`),
        );
      }
    };
    check("minimum", s.minimum, (c) => c < 0);
    check("maximum", s.maximum, (c) => c > 0);
    check("exclusiveMinimum", s.exclusiveMinimum, (c) => c <= 0);
    check("exclusiveMaximum", s.exclusiveMaximum, (c) => c >= 0);
    if (s.multipleOf !== null) {
      const m = s.multipleOf;
      // num / m is an integer when num.num*m.den is divisible by num.den*m.num.
      if ((num.num * m.den) % (num.den * m.num) !== 0n) {
        this.addError(() =>
          kind("MultipleOf", ["multipleOf"], `multipleOf: got ${englishFloat(ratFloat(num))}, want ${englishFloat(ratFloat(m))}`),
        );
      }
    }
  }

  condValidate(): void {
    const s = this.sch;
    if (s.not !== null && this.validateSelf(s.not, true) === null) {
      this.addError(() => kind("Not", [], "'not' failed"));
    }
    if (s.allOf.length > 0) {
      const errors: ValidationError[] = [];
      for (const sch of s.allOf) {
        const err = this.validateSelf(sch, false);
        if (err !== null) {
          errors.push(err);
          if (this.boolResult) break;
        }
      }
      if (errors.length > 0) {
        this.addErrors(errors, () => kind("AllOf", ["allOf"], "'allOf' failed"));
      }
    }
    if (s.anyOf.length > 0) {
      let matched = false;
      const errors: ValidationError[] = [];
      for (const sch of s.anyOf) {
        const err = this.validateSelf(sch, false);
        if (err !== null) {
          errors.push(err);
        } else {
          matched = true;
          break;
        }
      }
      if (!matched) {
        this.addErrors(errors, () => kind("AnyOf", ["anyOf"], "'anyOf' failed"));
      }
    }
    if (s.oneOf.length > 0) {
      let matched = -1;
      const errors: ValidationError[] = [];
      for (let i = 0; i < s.oneOf.length; i++) {
        const err = this.validateSelf(s.oneOf[i] as Schema, matched !== -1);
        if (err !== null) {
          if (matched === -1) errors.push(err);
        } else if (matched === -1) {
          matched = i;
        } else {
          const first = matched;
          this.addError(() =>
            kind("OneOf", ["oneOf"], `'oneOf' failed, subschemas ${englishInt(first)}, ${englishInt(i)} matched`),
          );
          break;
        }
      }
      if (matched === -1) {
        this.addErrors(errors, () => kind("OneOf", ["oneOf"], "'oneOf' failed, none matched"));
      }
    }
    if (s.if !== null) {
      if (this.validateSelf(s.if, true) === null) {
        if (s.then !== null) this.addErr(this.validateSelf(s.then, false));
      } else if (s.else !== null) {
        this.addErr(this.validateSelf(s.else, false));
      }
    }
  }
}

const emptyKind: ErrorKind = { name: "", keywordPath: [], message: "" };

// duplicates returns the positions of the first item that equals an earlier
// one and of the first earlier one it equals, as the library's duplicates
// finds them (pairwise up to 20 items, by hash above), or null.
function duplicates(arr: Value[]): [number, number] | null {
  const first = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) {
    const key = canonical(arr[i] ?? null);
    const j = first.get(key);
    if (j !== undefined) return [j, i];
    first.set(key, i);
  }
  return null;
}

// canonical is a text that two values share exactly when equals holds.
function canonical(v: Value): string {
  if (v instanceof Map) {
    const keys = [...v.keys()].sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonical(v.get(k) ?? null))
        .join(",") +
      "}"
    );
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "number" || typeof v === "bigint") {
    const r = ratOf(v);
    const g = gcd(r.num < 0n ? -r.num : r.num, r.den);
    return "n" + String(r.num / g) + "/" + String(r.den / g);
  }
  return JSON.stringify(v);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}
