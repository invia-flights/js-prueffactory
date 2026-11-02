// The JSON Schema (draft 2020-12) of report.json, and validation against it.
// The same bytes are written next to every report.json as report.schema.json.
// The schema file ships beside this module and is read once at runtime.

import { readFileSync } from "node:fs";

import { sortStrings } from "../gocompat/strings.ts";
import { compile, type Leaf, parse, type Validator } from "./validator.ts";

/** FileName is the name of the schema file written next to report.json. */
export const FileName = "report.schema.json";

let schemaBytes: Uint8Array | undefined;
let compiled: Validator | undefined;

function bytes(): Uint8Array {
  schemaBytes ??= readFileSync(new URL(FileName, import.meta.url));
  return schemaBytes;
}

/** report returns the schema document, a new copy on every call. */
export function report(): Uint8Array {
  return Uint8Array.from(bytes());
}

function validator(): Validator {
  if (compiled === undefined) {
    const doc = JSON.parse(Buffer.from(bytes()).toString("utf8")) as Record<
      string,
      unknown
    >;
    compiled = compile(doc, "2020-12");
  }
  return compiled;
}

/**
 * leaves validates a JSON document and returns its violations, empty when
 * it is valid. A document that is not JSON throws Go's error text.
 */
export function leaves(doc: Uint8Array): Leaf[] {
  const parsed = parse(doc);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  return validator().validate(parsed.value);
}

/**
 * validate checks a JSON document against the schema and returns one message
 * per violation, "/<instance location>: <text>", sorted byte-wise; empty when
 * the document is valid.
 */
export function validate(doc: Uint8Array): string[] {
  const parsed = parse(doc);
  if ("error" in parsed) {
    return [`not valid JSON: ${parsed.error}`];
  }
  return sortStrings(
    validator()
      .validate(parsed.value)
      .map((l) => `${l.instance}: ${l.message}`),
  );
}
