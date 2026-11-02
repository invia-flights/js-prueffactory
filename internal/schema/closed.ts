// The string fields of the Report whose value the JSON Schema fixes. Redaction
// never rewrites them.

import { readFileSync } from "node:fs";

let cached: ReadonlySet<string> | undefined;

/**
 * closedPaths returns the string fields whose value the schema fixes, as
 * dotted JSON paths: "findings.locations.path_base". A field is closed when
 * its schema has an enum or const with a string in it, a pattern or a format.
 * Its value then comes from a set or a shape the schema owns and not from the
 * project, so nothing may rewrite it, whatever the text it holds looks like.
 * Arrays add no segment, so "findings.locations.path_base" is the path_base of
 * every location of every Finding.
 *
 * It reads report.schema.json beside this file, so a field added to the schema
 * later is closed from then on without a change elsewhere. The result is
 * shared; callers must not change it.
 */
export function closedPaths(): ReadonlySet<string> {
  if (cached === undefined) {
    const doc = JSON.parse(
      readFileSync(new URL("report.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    if (!isObject(doc)) {
      throw new Error("schema: report.schema.json is not a JSON object");
    }
    const out = new Set<string>();
    collectClosed(doc, doc, "", out, 0);
    cached = out;
  }
  return cached;
}

/** maxSchemaDepth stops a schema that refers to itself. */
const maxSchemaDepth = 64;

type JSONObject = Record<string, unknown>;

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(n: JSONObject, key: string): unknown {
  return Object.hasOwn(n, key) ? n[key] : undefined;
}

// collectClosed walks a schema node and marks path when the node closes a
// string. Every keyword that applies to the same value (allOf, oneOf, if, then,
// a $ref and so on) is followed with the same path; properties add a segment
// and items add none.
function collectClosed(
  root: JSONObject,
  node: unknown,
  path: string,
  out: Set<string>,
  depth: number,
): void {
  if (!isObject(node) || depth > maxSchemaDepth) {
    return;
  }
  if (path !== "" && closesString(node)) {
    out.add(path);
  }
  const ref = own(node, "$ref");
  if (typeof ref === "string") {
    const target = resolveRef(root, ref);
    if (target !== undefined) {
      collectClosed(root, target, path, out, depth + 1);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const list = own(node, key);
    if (Array.isArray(list)) {
      for (const sub of list) {
        collectClosed(root, sub, path, out, depth + 1);
      }
    }
  }
  for (const key of ["if", "then", "else", "items", "contains", "not"]) {
    if (Object.hasOwn(node, key)) {
      collectClosed(root, node[key], path, out, depth + 1);
    }
  }
  const prefixItems = own(node, "prefixItems");
  if (Array.isArray(prefixItems)) {
    for (const sub of prefixItems) {
      collectClosed(root, sub, path, out, depth + 1);
    }
  }
  const props = own(node, "properties");
  if (isObject(props)) {
    for (const [name, sub] of Object.entries(props)) {
      const child = path === "" ? name : `${path}.${name}`;
      collectClosed(root, sub, child, out, depth + 1);
    }
  }
}

/** closesString reports whether the node fixes the value of a string. */
function closesString(n: JSONObject): boolean {
  if (Object.hasOwn(n, "pattern") || Object.hasOwn(n, "format")) {
    return true;
  }
  if (typeof own(n, "const") === "string") {
    return true;
  }
  const list = own(n, "enum");
  return Array.isArray(list) && list.some((v) => typeof v === "string");
}

/** resolveRef follows a local reference such as "#/$defs/sha256". */
function resolveRef(root: JSONObject, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let cur: unknown = root;
  for (let part of ref.slice(2).split("/")) {
    if (!isObject(cur)) {
      return undefined;
    }
    part = part.replaceAll("~1", "/").replaceAll("~0", "~");
    cur = own(cur, part);
  }
  return cur;
}
