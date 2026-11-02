// JSON Schema validation with the judgements of the Go build. Go validated
// with santhosh-tekuri/jsonschema/v6; the port validates with Ajv and turns
// Ajv's errors into the leaves the Go library reported: the same instance
// locations, the same keywords and, for the keywords the tool's schemas use,
// the same English text. Where the texts still differ (date formats other
// than date-time, keywords no schema of the tool uses) only the wording
// differs, which the port allows (spec: "YAML and JSON Schema judgements").

import { Ajv, type AnySchemaObject, type ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { formatFloatV, quote } from "../gocompat/fmt.ts";
import { formatFloatF } from "../gocompat/strconv.ts";
import { checkValid } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { goFormats } from "./format.ts";

/** Leaf is one violation, as a leaf of the Go library's error tree. */
export interface Leaf {
  /** instance is "/" plus the JSON Pointer tokens joined by "/", unescaped. */
  readonly instance: string;
  /** keyword is the failing keyword; "" for not (Go names none). */
  readonly keyword: string;
  readonly message: string;
}

export type Draft = "2020-12" | "draft-07";

/** Validator validates parsed JSON values against one compiled schema. */
export interface Validator {
  /** validate returns the leaves of the violations, empty when valid. */
  validate(instance: unknown): Leaf[];
}

const addFormats = addFormatsModule.default;

/**
 * compile compiles a schema document of the given draft with format
 * assertions on, as the Go build's compiler did (AssertFormat).
 */
export function compile(schema: AnySchemaObject, draft: Draft): Validator {
  const options = {
    allErrors: true,
    verbose: true,
    strict: false,
    logger: false as const,
    validateFormats: true,
  };
  const ajv = draft === "2020-12" ? new Ajv2020(options) : new Ajv(options);
  addFormats(ajv);
  for (const [name, check] of Object.entries(goFormats)) {
    if (check !== undefined) {
      ajv.addFormat(name, (value: string) => check(value) === undefined);
    }
  }
  const fn = ajv.compile(schema);
  return {
    validate(instance: unknown): Leaf[] {
      if (fn(instance)) {
        return [];
      }
      return toLeaves(fn.errors ?? []);
    },
  };
}

/**
 * parse reads a JSON document as the Go library's UnmarshalJSON did, and
 * returns the value or the text of Go's error.
 */
export function parse(
  doc: Uint8Array,
): { value: unknown } | { error: string } {
  let start = 0;
  while (
    start < doc.length &&
    (doc[start] === 0x20 ||
      doc[start] === 0x09 ||
      doc[start] === 0x0a ||
      doc[start] === 0x0d)
  ) {
    start++;
  }
  if (start === doc.length) {
    return { error: "EOF" };
  }
  const err = checkValid(doc);
  if (err !== undefined) {
    // Go's json.Decoder reads one value and then looks for the end of the
    // input; its texts differ from json.Unmarshal's for these two cases.
    if (err.message === "unexpected end of JSON input") {
      return { error: "unexpected EOF" };
    }
    if (err.message.endsWith("after top-level value")) {
      return { error: "invalid character after top-level value" };
    }
    return { error: err.message };
  }
  return { value: JSON.parse(goString(doc)) as unknown };
}

// The keywords whose failure ends the Go library's checks of a schema: it
// tests them in this order and returns at the first that fails.
const shortCircuit = ["type", "const", "enum", "format"];

function unescapeToken(t: string): string {
  return t.replaceAll("~1", "/").replaceAll("~0", "~");
}

function instanceOf(e: ErrorObject): string {
  return (
    "/" + e.instancePath.split("/").slice(1).map(unescapeToken).join("/")
  );
}

/** node is the schema object an error's keyword belongs to. */
function nodeOf(e: ErrorObject): string {
  return e.schemaPath.slice(0, e.schemaPath.lastIndexOf("/"));
}

function toLeaves(errors: readonly ErrorObject[]): Leaf[] {
  // Where the Go library stopped early, it reported one error for the node
  // and nothing below it.
  const stopped = new Map<string, string>();
  for (const e of errors) {
    if (!shortCircuit.includes(e.keyword)) {
      continue;
    }
    const key = `${e.instancePath}\u0000${nodeOf(e)}`;
    const seen = stopped.get(key);
    if (
      seen === undefined ||
      shortCircuit.indexOf(e.keyword) < shortCircuit.indexOf(seen)
    ) {
      stopped.set(key, e.keyword);
    }
  }
  const skipped = (e: ErrorObject): boolean => {
    for (const [key, keyword] of stopped) {
      const [inst = "", node = ""] = key.split("\u0000");
      if (e.instancePath === inst && nodeOf(e) === node) {
        return e.keyword !== keyword;
      }
      if (
        e.schemaPath.startsWith(node + "/") &&
        (e.instancePath === inst || e.instancePath.startsWith(inst + "/")) &&
        nodeOf(e) !== node
      ) {
        return true;
      }
    }
    return false;
  };

  const out: Leaf[] = [];
  // required and additionalProperties: Ajv reports one error per property,
  // Go one per object.
  const grouped = new Map<string, { leaf: number; names: string[] }>();
  for (const e of errors) {
    if (skipped(e)) {
      continue;
    }
    const instance = instanceOf(e);
    switch (e.keyword) {
      case "anyOf":
      case "if":
        // The failing branches are the leaves.
        continue;
      case "oneOf": {
        const passing = (e.params as { passingSchemas: number[] | null })
          .passingSchemas;
        if (passing === null) {
          continue;
        }
        out.push({
          instance,
          keyword: "oneOf",
          message: `'oneOf' failed, subschemas ${String(passing[0])}, ${String(passing[1])} matched`,
        });
        continue;
      }
      case "required":
      case "additionalProperties": {
        const name =
          e.keyword === "required"
            ? (e.params as { missingProperty: string }).missingProperty
            : (e.params as { additionalProperty: string }).additionalProperty;
        const key = `${e.keyword}\u0000${e.instancePath}\u0000${e.schemaPath}`;
        const g = grouped.get(key);
        if (g === undefined) {
          grouped.set(key, { leaf: out.length, names: [name] });
          out.push({ instance, keyword: e.keyword, message: "" });
        } else {
          g.names.push(name);
        }
        continue;
      }
      default:
        out.push({ instance, keyword: keywordOf(e), message: messageOf(e) });
    }
  }
  for (const [key, g] of grouped) {
    const keyword = key.slice(0, key.indexOf("\u0000"));
    const leaf = out[g.leaf];
    if (leaf === undefined) {
      continue;
    }
    const names = g.names.map(goQuote).join(", ");
    out[g.leaf] = {
      ...leaf,
      message:
        keyword === "required"
          ? g.names.length === 1
            ? `missing property ${names}`
            : `missing properties ${names}`
          : `additional properties ${names} not allowed`,
    };
  }
  return out;
}

function keywordOf(e: ErrorObject): string {
  switch (e.keyword) {
    case "not":
      return "";
    case "false schema":
      return "";
    default:
      return e.keyword;
  }
}

/** goQuote is the Go library's quote: %q in single quotes. */
export function goQuote(s: string): string {
  // As Go: the replacements run over the whole %q text, quotes included, so
  // a value that ends with a backslash loses that escape ('\' for "\\").
  const q = quote(s).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return "'" + q.slice(1, -1) + "'";
}

/** display is the Go library's display of a primitive value (fmt %v). */
function display(v: unknown): string {
  if (typeof v === "string") {
    return goQuote(v);
  }
  if (v === null) {
    return "<nil>";
  }
  if (typeof v === "number") {
    return formatFloatV(v);
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return "value";
}

const typeOrder = [
  "null",
  "boolean",
  "number",
  "integer",
  "string",
  "array",
  "object",
];

function goType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function messageOf(e: ErrorObject): string {
  const data: unknown = e.data;
  const schema: unknown = e.schema;
  switch (e.keyword) {
    case "type": {
      const want = (Array.isArray(schema) ? schema : [schema]).filter(
        (t): t is string => typeof t === "string",
      );
      const ordered = typeOrder.filter((t) => want.includes(t));
      return `got ${goType(data)}, want ${ordered.join(" or ")}`;
    }
    case "const":
      return isPrimitive(schema)
        ? `value must be ${display(schema)}`
        : "'const' failed";
    case "enum": {
      const values = Array.isArray(schema) ? (schema as unknown[]) : [];
      if (!values.every(isPrimitive)) {
        return "'enum' failed";
      }
      if (values.length === 1) {
        return `value must be ${display(values[0])}`;
      }
      return `value must be one of ${values.map(display).join(", ")}`;
    }
    case "format": {
      const name = String(schema);
      const reason =
        typeof data === "string" ? goFormats[name]?.(data) : undefined;
      return reason === undefined
        ? `${display(data)} is not valid ${name}`
        : `${display(data)} is not valid ${name}: ${reason}`;
    }
    case "pattern":
      return `${goQuote(String(data))} does not match pattern ${goQuote(String(schema))}`;
    case "minLength":
    case "maxLength":
      // Go counts runes, as Ajv does.
      return `${e.keyword}: got ${englishInt(Array.from(String(data)).length)}, want ${englishInt(Number(schema))}`;
    case "minItems":
    case "maxItems":
      return `${e.keyword}: got ${englishInt(Array.isArray(data) ? data.length : 0)}, want ${englishInt(Number(schema))}`;
    case "minProperties":
    case "maxProperties":
      return `${e.keyword}: got ${englishInt(typeof data === "object" && data !== null ? Object.keys(data).length : 0)}, want ${englishInt(Number(schema))}`;
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return `${e.keyword}: got ${englishFloat(Number(data))}, want ${englishFloat(Number(schema))}`;
    case "not":
      return "'not' failed";
    case "false schema":
      return "false schema";
    default:
      // A keyword the tool's schemas do not use: Ajv's own words.
      return `${e.keyword}: ${e.message ?? "failed"}`;
  }
}

function isPrimitive(v: unknown): boolean {
  return typeof v !== "object" || v === null;
}

/**
 * englishInt is %d through Go's English message printer: digits grouped by
 * three with commas.
 */
export function englishInt(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + group(String(Math.abs(Math.trunc(n))));
}

function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ",";
    }
    out += digits.charAt(i);
  }
  return out;
}

const superscript: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻",
};

/**
 * englishFloat is %v of a float64 through Go's English message printer: the
 * shortest digits, in exponent form ("1.5×10⁰⁶") where %v would use one
 * (exponent below -4 or from 6 on), else plain with grouped thousands.
 */
export function englishFloat(x: number): string {
  if (x === 0) {
    return Object.is(x, -0) ? "-0" : "0";
  }
  const sign = x < 0 ? "-" : "";
  const [mant = "", expText = "0"] = Math.abs(x).toExponential().split("e");
  const exp = Number(expText);
  if (exp < -4 || exp >= 6) {
    const e = (exp < 0 ? "-" : "") + String(Math.abs(exp)).padStart(2, "0");
    return (
      sign + mant + "×10" + e.replace(/[0-9-]/g, (c) => superscript[c] ?? c)
    );
  }
  const [intPart = "", frac] = formatFloatF(Math.abs(x)).split(".");
  return sign + group(intPart) + (frac === undefined ? "" : "." + frac);
}
