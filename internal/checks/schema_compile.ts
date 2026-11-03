// schema.compile compiles every JSON Schema of the project with Ajv 8 from the
// toolset volume (Go: schema_compile.go): once without strict mode, where a
// failure is an error without a Gate, and once with it, where a failure is a
// warning. Test data only gets notes. The Check reads the schema files on the host and
// hands them to the helper parsed, so the helper never opens a project path
// and nothing is fetched. Ajv, ajv-draft-04 and ajv-formats run in the
// container, so the host needs no draft-04 support of its own.
import { readFileSync } from "node:fs";

import type { FileClass, Project } from "../discovery/discovery.ts";
import { TestData } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { formatNumber, quoteJSONString } from "../gocompat/json.ts";
import { ext } from "../gocompat/path.ts";
import { compareBytes, trimSpace } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  ConfidenceLikely,
  type Finding,
  KindDefect,
  KindHint,
  type Limitation,
  NotApplicable,
  SeverityError,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  type ToolRef,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { DefaultNodeMajor, nodeImage, VariantDebian } from "../toolset/node.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { imageRef } from "../toolset/toolset.ts";
import { MountPath, ToolBin } from "../toolvolume/toolvolume.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { type Check, register } from "./check.ts";
import {
  failedToRun,
  helperFailed,
  toolsetUnavailable,
} from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { inNodeModules, readRegular } from "./repo_targets.ts";
import { shownPath, shownURL, shownWord } from "./shown_text.ts";
import {
  requireShape,
  shape,
  ToolOutputs,
  UnreadableOutput,
} from "./tool_output.ts";
import { errorMessage } from "../gocompat/errors.ts";

export const schemaCompileID = "schema.compile";

const schemaCompileScript = readFileSync(
  new URL("js/schema-compile.js", import.meta.url),
);

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

  images(c) {
    return c.package !== null ? [] : [schemaCompileImage()];
  },

  /** usesToolset says that Ajv comes from the toolset volume. */
  usesToolset(c) {
    return c.package === null;
  },

  run: runSchemaCompile,
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

function schemaCompileImage(): string {
  const img = nodeImage(DefaultNodeMajor, VariantDebian);
  if (img === undefined) {
    throw new Error("the toolset has no default Node image");
  }
  return imageRef(img);
}

/** SchemaProblem is one way a compile failed. */
export interface SchemaProblem {
  kind: string;
  message: string;
}

/** SchemaCompileResult is the helper's result for one schema file. */
export interface SchemaCompileResult {
  path: string;
  draft: string;
  lax: SchemaProblem | null;
  strict: SchemaProblem | null;
  remote: string[];
}

export interface SchemaCompileOutput {
  version: string;
  schemas: SchemaCompileResult[];
}

const str: Schema = { kind: "string" };
const problemSchema: Schema = {
  kind: "pointer",
  elem: {
    kind: "struct",
    type: "checks.schemaProblem",
    fields: [
      { name: "kind", schema: str },
      { name: "message", schema: str },
    ],
  },
};
const outputSchema: Schema = {
  kind: "struct",
  type: "checks.schemaCompileOutput",
  fields: [
    { name: "version", schema: str },
    {
      name: "schemas",
      schema: {
        kind: "slice",
        type: "[]checks.schemaCompileResult",
        elem: {
          kind: "struct",
          type: "checks.schemaCompileResult",
          fields: [
            { name: "path", schema: str },
            { name: "draft", schema: str },
            { name: "lax", schema: problemSchema },
            { name: "strict", schema: problemSchema },
            {
              name: "remote",
              schema: { kind: "slice", type: "[]string", elem: str },
            },
          ],
        },
      },
    },
  ],
};

/** schemaProblemShape is a problem of the helper's answer: null, or a kind and a message. */
const schemaProblemShape = shape.nullable(
  shape.object({ kind: shape.string, message: shape.string }),
);

/** helperOutputShape is the answer the schema-compile helper documents. */
const helperOutputShape = shape.object({
  version: shape.string,
  schemas: shape.array(
    shape.object({
      path: shape.string,
      draft: shape.string,
      lax: schemaProblemShape,
      strict: schemaProblemShape,
      remote: shape.array(shape.string),
    }),
  ),
});

/**
 * parseOutput decodes the helper's answer, which has to answer for every
 * schema file it was given; it throws UnreadableOutput for anything else.
 */
function parseOutput(
  stdout: Uint8Array,
  expected: number,
): SchemaCompileOutput {
  let out: { version: string; schemas: GoSlice | null };
  try {
    out = unmarshal(stdout, outputSchema) as typeof out;
  } catch (err) {
    throw new UnreadableOutput(
      `the Ajv helper printed no JSON: ${errorMessage(err)}`,
      "it is not valid JSON of the expected kind",
      { cause: err },
    );
  }
  requireShape("the Ajv helper", stdout, helperOutputShape);
  if ((out.schemas?.items().length ?? 0) !== expected) {
    throw new UnreadableOutput(
      "the Ajv helper answered for another number of schemas than it was given",
      "it does not answer for every schema file it was given",
    );
  }
  const schemas = (out.schemas?.items() ?? []) as (Omit<
    SchemaCompileResult,
    "remote"
  > & { remote: GoSlice | null })[];
  return {
    version: out.version,
    schemas: schemas.map((s) => ({
      ...s,
      remote: (s.remote?.items() ?? []) as string[],
    })),
  };
}

const escapes: Readonly<Record<number, string>> = {
  0x3c: "\\u003c",
  0x3e: "\\u003e",
  0x26: "\\u0026",
};

/**
 * compactJSON is what Go's json.Marshal writes for a json.RawMessage: the
 * value without white space between tokens, with <, >, & and U+2028, U+2029
 * escaped inside strings and every other byte kept. data is valid JSON.
 */
export function compactJSON(data: Uint8Array): Buffer {
  const out: number[] = [];
  const push = (text: string) => {
    for (let k = 0; k < text.length; k++) out.push(text.charCodeAt(k));
  };
  let inString = false;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] ?? 0;
    if (!inString) {
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        continue;
      }
      inString = c === 0x22;
      out.push(c);
      continue;
    }
    const escaped = escapes[c];
    if (c === 0x5c) {
      out.push(c, data[i + 1] ?? 0);
      i++;
    } else if (c === 0x22) {
      inString = false;
      out.push(c);
    } else if (escaped !== undefined) {
      push(escaped);
    } else if (
      c === 0xe2 &&
      data[i + 1] === 0x80 &&
      (data[i + 2] === 0xa8 || data[i + 2] === 0xa9)
    ) {
      push(data[i + 2] === 0xa8 ? "\\u2028" : "\\u2029");
      i += 2;
    } else {
      out.push(c);
    }
  }
  return Buffer.from(out);
}

/** schemaHelperInput builds the helper's input document. */
export function schemaHelperInput(targets: readonly SchemaTarget[]): Buffer {
  const q = (s: string) => Buffer.from(quoteJSONString(s, true));
  const parts: Buffer[] = [
    Buffer.from(`{"modules":`),
    q(ToolBin),
    Buffer.from(`,"schemas":[`),
  ];
  targets.forEach((t, i) => {
    parts.push(
      Buffer.from(i === 0 ? `{"path":` : `,{"path":`),
      q(t.path),
      Buffer.from(`,"draft":`),
      q(t.draft),
      Buffer.from(`,"schema":`),
      compactJSON(t.schema),
      Buffer.from("}"),
    );
  });
  parts.push(Buffer.from("]}"));
  return Buffer.concat(parts);
}

async function runSchemaCompile(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const res: Result = { status: StatusCompleted };
  if (input.toolsetVolume === "") {
    return toolsetUnavailable(input, "Ajv");
  }

  const [targets, over] = schemaTargets(input.project);
  res.command = ["node", "/jspf/schema-compile.js", "/jspf/input.json"];
  const docker = input.docker;
  if (docker === null) {
    // Go dereferenced the nil driver here and panicked.
    throw new Error("no Docker driver is configured");
  }
  let container: ContainerResult;
  try {
    container = await docker.runContainer(signal, {
      name: "schema-compile",
      image: schemaCompileImage(),
      cmd: res.command,
      workDir: "/jspf",
      network: input.network,
      mounts: [
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
      ],
      files: [
        {
          path: "/jspf/schema-compile.js",
          mode: 0o644,
          content: schemaCompileScript,
        },
        {
          path: "/jspf/input.json",
          mode: 0o644,
          content: schemaHelperInput(targets),
        },
      ],
    });
  } catch (err) {
    return failedToRun(res, err);
  }
  const exit = container.exitCode;
  res.tool = { name: "ajv", version: null, exit_code: exit };

  if (exit !== 0) {
    return helperFailed(res, "Ajv", container, 800);
  }
  // A helper that exits cleanly but prints something else than its answer is
  // a tool problem: nothing is said about the schema files.
  const outputs = new ToolOutputs(schemaCompileID, input.context.id);
  const out = outputs.read("ajv", "schema-compile", container, () =>
    parseOutput(container.stdout, targets.length),
  );
  if (out === undefined) {
    outputs.apply(res);
    return res;
  }
  const interpreted = interpretSchemaCompileTargets(input, out, targets, over);
  interpreted.command = res.command;
  if (interpreted.tool) {
    interpreted.tool.exit_code = exit;
  }
  return interpreted;
}

/** interpretSchemaCompile turns the helper's output into Findings and a status. */
export function interpretSchemaCompile(
  input: Input,
  out: SchemaCompileOutput,
): Result {
  const [targets] = schemaTargets(input.project);
  return interpretSchemaCompileTargets(input, out, targets, []);
}

function interpretSchemaCompileTargets(
  input: Input,
  out: SchemaCompileOutput,
  targets: readonly SchemaTarget[],
  over: readonly string[],
): Result {
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  const contextTools: ToolRef[] = [];
  const res: Result = {
    status: StatusCompleted,
    tool: { name: "ajv", version: out.version, exit_code: null },
  };
  for (const name of ["ajv", "ajv-draft-04", "ajv-formats"]) {
    const tool = npmTool(name);
    if (tool !== undefined) {
      contextTools.push({
        name: tool.name,
        version: tool.version,
        digest: tool.integrity,
      });
    }
  }
  if (contextTools.length > 0) res.contextTools = contextTools;

  const classOf = new Map<string, FileClass>();
  for (const t of targets) {
    classOf.set(t.path, t.class);
  }
  const remote: string[] = [];
  for (const s of out.schemas) {
    const testData = classOf.get(s.path) === TestData;
    if (s.lax !== null) {
      findings.push(schemaFinding(input, s, s.lax, testData));
    } else if (s.strict !== null) {
      findings.push(schemaFinding(input, s, s.strict, testData));
    }
    if (s.remote.length > 0) {
      limitations.push({
        reason_code: "remote_ref_not_fetched",
        message:
          "the schema refers to " +
          s.remote.map((r) => shownURL(r, "reference")).join(", ") +
          ", which cannot be fetched without network access, so what it points to was not compiled",
        check_id: schemaCompileID,
        path: s.path,
      });
      remote.push(s.path);
    }
  }
  for (const p of over) {
    limitations.push({
      reason_code: "schema_files_not_examined",
      message:
        "the project has more JSON Schema files than one Run examines, so this one was left out",
      check_id: schemaCompileID,
      path: p,
    });
  }
  if (findings.length > 0) res.findings = findings;
  if (limitations.length > 0) res.limitations = limitations;

  if (over.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "schema_files_not_examined";
    res.reason = `${String(over.length)} JSON Schema file(s) were left out because the project has more than a Run examines`;
  } else if (remote.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "remote_ref_not_fetched";
    res.reason = `${String(remote.length)} schema(s) have a reference to another host that cannot be fetched offline`;
  } else {
    res.status = StatusCompleted;
  }
  return res;
}

/**
 * schemaFinding builds the Finding for one problem of one schema. A failure
 * without strict mode is an error (never a Gate) and a strict-only problem a warning, both
 * only a note in Test data.
 */
function schemaFinding(
  input: Input,
  s: SchemaCompileResult,
  p: SchemaProblem,
  testData: boolean,
): Finding {
  const f = newFinding({
    check_id: schemaCompileID,
    context_id: input.context.id,
    rule_id: p.kind,
    fingerprint: newFingerprint(schemaCompileID, p.kind, s.path, p.message),
    kind: KindDefect,
    locations: [input.location("primary", s.path, 0, 0)],
    evidence: [untrusted("tool_output", p.message, "ajv")],
    reproduction: input.reproduction(schemaCompileID),
    limitations: [],
  });
  if (p.kind === "strict-mode") {
    f.title = "JSON Schema breaks strict mode";
    f.message = `${shownPath(s.path)} (${shownWord(s.draft, "draft")}) compiles, but Ajv in strict mode reports: ${p.message}`;
    f.severity = SeverityWarning;
    f.confidence = ConfidenceLikely;
  } else {
    f.title = "JSON Schema does not compile";
    f.message = `${shownPath(s.path)} (${shownWord(s.draft, "draft")}) does not compile with Ajv: ${p.message}`;
    f.severity = SeverityError;
    f.confidence = ConfidenceConfirmed;
  }
  if (testData) {
    f.severity = SeverityNote;
    f.kind = KindHint;
  }
  return f;
}
