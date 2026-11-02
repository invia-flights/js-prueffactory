import type { FileClass, Project } from "../discovery/discovery.ts";
import { formatNumber, quoteJSONString } from "../gocompat/json.ts";
import { ext } from "../gocompat/path.ts";
import { compareBytes, trimSpace } from "../gocompat/strings.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { type Check, register } from "./check.ts";
import { inNodeModules, readRegular } from "./repo_targets.ts";

export const schemaCompileID = "schema.compile";

// schemaCompile compiles every JSON Schema of the project with Ajv 8 from the
// toolset volume. The Check reads the schema files on the host and hands them
// to the helper parsed, so the helper never opens a project path and nothing
// is fetched. The run arrives with ticket 16 of the port.
export const schemaCompile: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "schema.compile examines the whole project, not one package",
      ];
    }
    const [targets] = schemaTargets(p);
    if (targets.length === 0) {
      return [
        NotApplicable,
        "the project has no JSON or YAML file whose top-level $schema names a known JSON Schema draft",
      ];
    }
    return [Applicable, ""];
  },
};

register(schemaCompileID, schemaCompile);

/** maxSchemaBytes is the size above which a file is not read. */
const maxSchemaBytes = 4 << 20;
// maxSchemaFiles and maxSchemaTotalBytes bound what one container gets.
const maxSchemaFiles = 1000;
const maxSchemaTotalBytes = 32 << 20;

/**
 * schemaDrafts maps the `$schema` URIs of the drafts Ajv compiles, without
 * scheme and fragment, to the draft names the helper uses.
 */
const schemaDrafts = new Map([
  ["json-schema.org/draft-04/schema", "draft-04"],
  ["json-schema.org/draft-06/schema", "draft-06"],
  ["json-schema.org/draft-07/schema", "draft-07"],
  ["json-schema.org/draft/2019-09/schema", "2019-09"],
  ["json-schema.org/draft/2020-12/schema", "2020-12"],
]);

/** SchemaTarget is a JSON Schema file with the draft it names. */
export interface SchemaTarget {
  path: string;
  draft: string;
  class: FileClass;
  /** schema is the document as JSON, also for YAML files. */
  schema: Uint8Array;
}

/** draftOf returns the draft a `$schema` value names, or "". */
export function draftOf(uri: string): string {
  uri = trimSpace(uri);
  if (uri.endsWith("#")) {
    uri = uri.slice(0, -1);
  }
  if (uri.startsWith("http://")) {
    uri = uri.slice("http://".length);
  } else if (uri.startsWith("https://")) {
    uri = uri.slice("https://".length);
  } else {
    return "";
  }
  return schemaDrafts.get(uri) ?? "";
}

/**
 * schemaTargets returns the YAML and JSON files outside node_modules whose
 * top-level `$schema` names a known draft, in path order, and the paths of
 * those that are left out because the budget of one container is used up.
 * Files that are not regular, are too large or do not parse are not targets:
 * the other Checks report them.
 */
export function schemaTargets(
  p: Project,
): [targets: SchemaTarget[], over: string[]] {
  const targets: SchemaTarget[] = [];
  const over: string[] = [];
  let total = 0;
  for (const f of p.files) {
    const e = ext(f.path);
    if (
      (e !== ".json" && e !== ".yaml" && e !== ".yml") ||
      inNodeModules(f.path)
    ) {
      continue;
    }
    const data = readRegular(p.root, f.path, maxSchemaBytes + 1);
    if (data === undefined || data.length > maxSchemaBytes) {
      continue;
    }
    const doc = schemaDocument(e, data);
    if (doc === undefined) {
      continue;
    }
    const draft = draftOf(doc.uri);
    if (draft === "") {
      continue;
    }
    if (
      targets.length >= maxSchemaFiles ||
      total + doc.json.length > maxSchemaTotalBytes
    ) {
      over.push(f.path);
      continue;
    }
    total += doc.json.length;
    targets.push({ path: f.path, draft, class: f.class, schema: doc.json });
  }
  return [targets, over];
}

interface SchemaDoc {
  /** uri is the top-level $schema. */
  uri: string;
  json: Uint8Array;
}

const rawMap: Schema = {
  kind: "map",
  type: "map[string]json.RawMessage",
  elem: { kind: "raw" },
};

/**
 * schemaDocument reads a JSON or YAML file whose top level is an object with
 * a string `$schema`.
 */
function schemaDocument(e: string, data: Uint8Array): SchemaDoc | undefined {
  if (e === ".json") {
    try {
      const top = unmarshal(data, rawMap) as Map<string, Uint8Array> | null;
      // Go unmarshals a missing key's nil RawMessage, which is an error.
      const raw = top?.get("$schema") ?? new Uint8Array();
      const uri = unmarshal(raw, { kind: "string" }) as string;
      return { uri, json: data };
    } catch {
      return undefined;
    }
  }
  let v: unknown;
  try {
    v = yaml.unmarshal(data, { kind: "any" });
  } catch {
    return undefined;
  }
  const top = jsonValue(v);
  if (!(top instanceof Map)) {
    return undefined;
  }
  const uri: unknown = top.get("$schema");
  if (typeof uri !== "string") {
    return undefined;
  }
  const json = marshalValue(top);
  if (json === undefined) {
    return undefined;
  }
  return { uri, json: Buffer.from(json, "utf8") };
}

/**
 * jsonValue turns what yaml.v3 decodes into something encoding/json can
 * write: mappings with non-string keys get their keys formatted, and values
 * JSON has no type for (timestamps) become strings.
 */
function jsonValue(v: unknown): unknown {
  if (v instanceof yaml.AnyMap) {
    const out = new Map<string, unknown>();
    for (const [k, e] of v) {
      out.set(yaml.sprint(k), jsonValue(e));
    }
    return out;
  }
  if (v instanceof Map) {
    const out = new Map<string, unknown>();
    for (const [k, e] of v as Map<string, unknown>) {
      out.set(k, jsonValue(e));
    }
    return out;
  }
  if (Array.isArray(v)) {
    return v.map(jsonValue);
  }
  if (
    v === null ||
    typeof v === "boolean" ||
    typeof v === "string" ||
    typeof v === "bigint" ||
    typeof v === "number" ||
    v instanceof yaml.GoUint64
  ) {
    return v;
  }
  return yaml.sprint(v);
}

/**
 * marshalValue is json.Marshal of what jsonValue returns: keys sorted
 * byte-wise, <, > and & escaped. It returns undefined where Go's Marshal
 * fails: for NaN and the infinities.
 */
function marshalValue(v: unknown): string | undefined {
  if (v === null) {
    return "null";
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  if (typeof v === "string") {
    return quoteJSONString(v, true);
  }
  if (typeof v === "bigint") {
    return v.toString();
  }
  if (v instanceof yaml.GoUint64) {
    return v.value.toString();
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? formatNumber(v) : undefined;
  }
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const e of v) {
      const s = marshalValue(e);
      if (s === undefined) {
        return undefined;
      }
      parts.push(s);
    }
    return "[" + parts.join(",") + "]";
  }
  if (v instanceof Map) {
    const entries = [...(v as Map<string, unknown>)].sort(([a], [b]) =>
      compareBytes(a, b),
    );
    const parts: string[] = [];
    for (const [k, e] of entries) {
      const s = marshalValue(e);
      if (s === undefined) {
        return undefined;
      }
      parts.push(quoteJSONString(k, true) + ":" + s);
    }
    return "{" + parts.join(",") + "}";
  }
  return undefined;
}
