// GitLab's CI JSON Schema and the validation against it (Go:
// gitlab_ci_schema.go). The Go build validated with
// santhosh-tekuri/jsonschema; the port validates with its port in
// internal/jsonschema, which gives the same error tree and texts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { compareBytes } from "../gocompat/strings.ts";
import {
  compile,
  type CompiledSchema,
  type ValidationError,
  type Value,
} from "../jsonschema/jsonschema.ts";
import { pointerOf } from "./gitlab_ci_yaml.ts";

/**
 * gitlabCISchema is GitLab's published CI JSON Schema, copied unchanged from
 * app/assets/javascripts/editor/schema/ci.json of the v18.5.0 tag. The Check
 * never fetches it, and its SHA-256 is part of the Benchmark fingerprint.
 */
const gitlabCISchema = readFileSync(
  new URL("./data/gitlab-ci-schema-18.5.0.json", import.meta.url),
);

/** gitlabCISchemaVersion is the GitLab version the schema was taken from. */
export const gitlabCISchemaVersion = "18.5.0";

/** gitlabCISchemaSHA256 is the hex SHA-256 of the shipped schema. */
export function gitlabCISchemaSHA256(): string {
  return createHash("sha256").update(gitlabCISchema).digest("hex");
}

let compiled: CompiledSchema | Error | undefined;

function compiledCISchema(): CompiledSchema {
  if (compiled === undefined) {
    try {
      compiled = compile(JSON.parse(gitlabCISchema.toString("utf8")));
    } catch (err) {
      compiled = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (compiled instanceof Error) {
    throw compiled;
  }
  return compiled;
}

/** CISchemaError is one place where a document breaks the schema. */
export interface CISchemaError {
  /** pointer is the JSON pointer of the instance. */
  readonly pointer: string;
  readonly messages: readonly string[];
}

/**
 * failingLeaves returns the errors without causes. Where a value could
 * match several branches of an anyOf or oneOf, only the branches that got
 * furthest into the value count, because the others fail at the value
 * itself and only say that it is not what they expected.
 */
function failingLeaves(root: ValidationError): ValidationError[] {
  // Post-order with an explicit stack: an error tree is as deep as the
  // value, and a value may nest thousands of levels.
  const done = new Map<ValidationError, ValidationError[]>();
  const todo: ValidationError[] = [root];
  while (todo.length > 0) {
    const e = todo.at(-1);
    if (e === undefined) break;
    if (e.causes.length === 0) {
      done.set(e, [e]);
      todo.pop();
      continue;
    }
    const open = e.causes.filter((c) => !done.has(c));
    if (open.length > 0) {
      todo.push(...open);
      continue;
    }
    todo.pop();
    let branches = e.causes.map((c) => done.get(c) ?? []);
    if (e.kind.name === "AnyOf" || e.kind.name === "OneOf") {
      const deepest = (leaves: ValidationError[]): number =>
        leaves.reduce((d, l) => Math.max(d, l.instanceLocation.length), 0);
      const best = branches.reduce((d, b) => Math.max(d, deepest(b)), 0);
      branches = branches.filter((b) => deepest(b) === best);
    }
    const out: ValidationError[] = [];
    for (const b of branches) {
      for (const l of b) out.push(l);
    }
    done.set(e, out);
  }
  return done.get(root) ?? [];
}

/**
 * withoutIncludeWildcards returns the document with the wildcards of string
 * includes replaced by a letter. GitLab accepts `include: ci/*.yml`, but the
 * schema's pattern for the string form wants a word character before `.yml`
 * and so rejects it. The object form `local: ci/*.yml` passes as it is.
 */
function withoutIncludeWildcards(value: Value): Value {
  if (!(value instanceof Map)) {
    return value;
  }
  const fix = (e: Value): Value =>
    typeof e === "string" ? e.replace(/[*?]/g, "x") : e;
  const inc = value.get("include");
  let include: Value;
  if (Array.isArray(inc)) {
    include = inc.map(fix);
  } else if (typeof inc === "string") {
    include = fix(inc);
  } else {
    return value;
  }
  const view = new Map(value);
  view.set("include", include);
  return view;
}

/**
 * validateCIDoc validates a document against the CI schema and returns the
 * places that fail, in pointer order. Where one value fails several branches
 * of the schema, its messages are listed together. It throws when the
 * schema cannot be applied.
 */
export function validateCIDoc(value: Value): CISchemaError[] {
  const err = compiledCISchema().validate(withoutIncludeWildcards(value));
  if (err === null) {
    return [];
  }
  const byPointer = new Map<string, string[]>();
  for (const l of failingLeaves(err)) {
    const ptr = pointerOf(l.instanceLocation);
    const msgs = byPointer.get(ptr) ?? [];
    if (!msgs.includes(l.kind.message)) {
      msgs.push(l.kind.message);
    }
    byPointer.set(ptr, msgs);
  }
  return [...byPointer]
    .map(([pointer, messages]) => ({ pointer, messages }))
    .sort((a, b) => compareBytes(a.pointer, b.pointer));
}

/** ciSchemaErrorText is the Evidence text of one failing place. */
export function ciSchemaErrorText(e: CISchemaError): string {
  const most = 4;
  let msgs = e.messages;
  let more = "";
  if (msgs.length > most) {
    more = `; and ${String(msgs.length - most)} more`;
    msgs = msgs.slice(0, most);
  }
  const ptr = e.pointer === "" ? "/" : e.pointer;
  return ptr + ": " + msgs.join("; ") + more;
}
