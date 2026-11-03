// The rule for a tool whose output cannot be read (spec "Trustworthy gates").
//
// A Tool adapter turns what a tool printed into Findings. When the output does
// not have the shape the tool documents, the adapter cannot say anything about
// the project: the Check execution ends tool_error (or partial, when other
// files or packages could be read) with the reason code
// tool_output_unreadable. The reading failure never becomes a Finding, and so
// never a Gate. A tool's output blames the project only when the tool says so
// in its own documented way, such as Biome's configuration diagnostics.
//
// How an adapter uses this file:
//
//   const outputs = new ToolOutputs(checkID, input.context.id);
//   ...
//   // once per tool call; `parse` is the adapter's reader and throws for
//   // output it cannot read. An unreadable call is recorded, not rethrown.
//   const found = outputs.read("hadolint", "hadolint-1", c, () => hadolintFindings(input, c.stdout));
//   if (found !== undefined) findings.push(...found);
//   ...
//   res.status = StatusCompleted;
//   outputs.apply(res); // tool_error, or partial when some call was read
//
// A reader that also wants to reject JSON with another shape than the
// documented one calls requireShape after it decoded the output. The raw
// stdout and stderr of an unreadable call become two artifacts of the
// execution, each capped at maxRawOutputBytes. The cut is made by finalize
// after redaction (Artifact.maxBytes), so a secret in the output is replaced
// before anything is cut off.
import { quote } from "../resultset/quote.ts";
import {
  type Artifact,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { newArtifact } from "../resultset/zero.ts";
import type { Result } from "./input.ts";

/** maxRawOutputBytes is the cap of each raw output artifact, in bytes. */
export const maxRawOutputBytes = 1 << 20;

/**
 * maxKeptCalls is how many unreadable calls of one execution keep their raw
 * output as artifacts. A Check that runs a tool once per file would
 * otherwise write two files for every one of them.
 */
export const maxKeptCalls = 3;

/**
 * UnreadableOutput is what a reader throws for output that does not have the
 * documented shape. message is for tests and logs; summary is the short,
 * fixed-vocabulary sentence the Report may show, and never holds text of the
 * tool or the project.
 */
export class UnreadableOutput extends Error {
  readonly summary: string;
  constructor(message: string, summary: string, options?: ErrorOptions) {
    super(message, options);
    this.summary = summary;
  }
}

const genericSummary = "it is not the output the tool documents";

// --- shapes of JSON output ---

/** Shape describes the JSON a tool documents, as far as an adapter relies on it. */
export type Shape =
  | { readonly kind: "string" | "number" | "boolean" }
  | { readonly kind: "array"; readonly of: Shape }
  | { readonly kind: "nullable"; readonly of: Shape }
  | { readonly kind: "map"; readonly of: Shape }
  | { readonly kind: "oneOf"; readonly values: readonly string[] }
  | {
      readonly kind: "object";
      readonly required: Readonly<Record<string, Shape>>;
      readonly optional: Readonly<Record<string, Shape>>;
    };

export const shape = {
  string: { kind: "string" } as Shape,
  number: { kind: "number" } as Shape,
  boolean: { kind: "boolean" } as Shape,
  array: (of: Shape): Shape => ({ kind: "array", of }),
  nullable: (of: Shape): Shape => ({ kind: "nullable", of }),
  /** mapOf is an object whose every value has the shape, whatever its keys. */
  mapOf: (of: Shape): Shape => ({ kind: "map", of }),
  /** oneOf is a string that is one of the documented words. */
  oneOf: (...values: string[]): Shape => ({ kind: "oneOf", values }),
  /**
   * object is a JSON object that has every required key with its shape. A
   * key in optional may be missing, but when it is there it has its shape.
   * Other keys are ignored: a tool may add keys without breaking its reader.
   */
  object: (
    required: Readonly<Record<string, Shape>>,
    optional: Readonly<Record<string, Shape>> = {},
  ): Shape => ({ kind: "object", required, optional }),
};

/**
 * requireShape decodes output as JSON and checks it against the shape the
 * tool documents. It throws UnreadableOutput when the output is not JSON or
 * has another shape, such as a renamed key, a missing array or a value of
 * another type. A reader calls it so that output of a changed shape never
 * reads as "nothing found".
 */
export function requireShape(
  tool: string,
  output: Uint8Array,
  expected: Shape,
): void {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(output).toString("utf8"));
  } catch (err) {
    throw new UnreadableOutput(
      `${tool} printed no JSON`,
      "it is not valid JSON",
      { cause: err },
    );
  }
  const problem = shapeProblem(doc, expected, "$");
  if (problem !== "") {
    throw new UnreadableOutput(
      `${tool} printed JSON of another shape than it documents: ${problem}`,
      `its JSON does not have the shape ${tool} documents`,
    );
  }
}

/** shapeProblem says where value breaks the shape, or "" when it fits. */
function shapeProblem(value: unknown, expected: Shape, at: string): string {
  switch (expected.kind) {
    case "string":
    case "number":
    case "boolean":
      return typeof value === expected.kind
        ? ""
        : `${at} is not a ${expected.kind}`;
    case "oneOf":
      return typeof value === "string" && expected.values.includes(value)
        ? ""
        : `${at} is not one of the documented words`;
    case "nullable":
      return value === null ? "" : shapeProblem(value, expected.of, at);
    case "map": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${at} is not an object`;
      }
      for (const [key, v] of Object.entries(value)) {
        const p = shapeProblem(v, expected.of, `${at}.${key}`);
        if (p !== "") {
          return p;
        }
      }
      return "";
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${at} is not an array`;
      }
      for (const [i, e] of (value as unknown[]).entries()) {
        const p = shapeProblem(e, expected.of, `${at}[${String(i)}]`);
        if (p !== "") {
          return p;
        }
      }
      return "";
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${at} is not an object`;
      }
      const obj = value as Record<string, unknown>;
      for (const [key, s] of Object.entries(expected.required)) {
        const found = member(obj, key);
        if (found === undefined) {
          return `${at}.${key} is missing`;
        }
        const p = shapeProblem(found.value, s, `${at}.${key}`);
        if (p !== "") {
          return p;
        }
      }
      for (const [key, s] of Object.entries(expected.optional)) {
        const found = member(obj, key);
        if (found !== undefined) {
          const p = shapeProblem(found.value, s, `${at}.${key}`);
          if (p !== "") {
            return p;
          }
        }
      }
      return "";
    }
  }
}

/**
 * member finds a key of a JSON object the way the adapters' decoder does
 * (Go's encoding/json): the exact key, or else one that differs only in case.
 */
function member(
  obj: Record<string, unknown>,
  key: string,
): { value: unknown } | undefined {
  if (Object.hasOwn(obj, key)) {
    return { value: obj[key] };
  }
  const lower = key.toLowerCase();
  const other = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return other === undefined ? undefined : { value: obj[other] };
}

// --- the raw output of one call ---

/** RawCall is what a tool call left behind: the two streams. */
export interface RawCall {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/**
 * rawOutputArtifacts are the two artifacts of one call's raw output. name
 * is the call's own name, such as the container name `hadolint-2`, and must
 * be unique within the Check. Each artifact may be cut to maxRawOutputBytes
 * by finalize, which records the cut.
 */
export function rawOutputArtifacts(
  checkID: string,
  contextID: string,
  name: string,
  c: RawCall,
): Artifact[] {
  const make = (stream: "stdout" | "stderr", bytes: Uint8Array): Artifact =>
    newArtifact({
      id: `raw-${name}-${stream}`,
      path: `artifacts/${checkID}/${contextID}/${name}.${stream}.txt`,
      media_type: "text/plain; charset=utf-8",
      content: bytes,
      maxBytes: maxRawOutputBytes,
    });
  return [make("stdout", c.stdout), make("stderr", c.stderr)];
}

/** RawFile is a file a tool wrote, such as the coverage report of c8. */
export interface RawFile {
  /** name is the file's name, unique among the files of one call. */
  readonly name: string;
  readonly content: Uint8Array;
}

/**
 * rawFileArtifacts are the artifacts of files a tool wrote and the adapter
 * could not read, for a tool whose answer is a file and not its stdout.
 * call is the call's own name; each artifact is `<call>.<name>` below the
 * Check's folder, cut to maxRawOutputBytes by finalize like the streams.
 */
export function rawFileArtifacts(
  checkID: string,
  contextID: string,
  call: string,
  files: readonly RawFile[],
): Artifact[] {
  return files.map((f) =>
    newArtifact({
      id: `raw-${call}-${f.name}`,
      path: `artifacts/${checkID}/${contextID}/${call}.${f.name}`,
      media_type: "text/plain; charset=utf-8",
      content: f.content,
      maxBytes: maxRawOutputBytes,
    }),
  );
}

interface Unreadable {
  tool: string;
  summary: string;
  where: string;
  artifacts: Artifact[];
  /** files is true for a call whose raw output is files the tool wrote. */
  files: boolean;
}

/**
 * ToolOutputs collects, for one Check execution, which tool calls had output
 * that could not be read, and turns them into the execution's status, reason
 * and artifacts.
 */
export class ToolOutputs {
  readonly #check: string;
  readonly #context: string;
  #read = 0;
  readonly #unreadable: Unreadable[] = [];

  constructor(checkID: string, contextID: string) {
    this.#check = checkID;
    this.#context = contextID;
  }

  /**
   * read runs parse, the adapter's reader of one call's output, and returns
   * what it returned. When it throws, the call is recorded as unreadable,
   * its raw output is kept, and read returns undefined. tool is the tool's
   * name as the Report shows it, call a name that is unique within the Check,
   * and where an optional trusted text that says which file or group of files
   * the call was about.
   */
  read<T>(
    tool: string,
    call: string,
    c: RawCall,
    parse: () => T,
    where = "",
  ): T | undefined {
    try {
      const out = parse();
      this.#read++;
      return out;
    } catch (err) {
      this.reject(
        tool,
        call,
        c,
        err instanceof UnreadableOutput ? err.summary : genericSummary,
        where,
      );
      return undefined;
    }
  }

  /**
   * reject records a call as unreadable for a reason the adapter found
   * itself, such as an exit code that contradicts an empty answer.
   */
  reject(
    tool: string,
    call: string,
    c: RawCall,
    summary: string,
    where = "",
  ): void {
    this.#unreadable.push({
      tool,
      summary,
      where,
      files: false,
      artifacts:
        this.#unreadable.length < maxKeptCalls
          ? rawOutputArtifacts(this.#check, this.#context, call, c)
          : [],
    });
  }

  /**
   * rejectFiles is reject for a tool whose answer is files it wrote, not
   * its stdout: the files are kept as the call's raw output.
   */
  rejectFiles(
    tool: string,
    call: string,
    files: readonly RawFile[],
    summary: string,
    where = "",
  ): void {
    this.#unreadable.push({
      tool,
      summary,
      where,
      files: true,
      artifacts:
        this.#unreadable.length < maxKeptCalls
          ? rawFileArtifacts(this.#check, this.#context, call, files)
          : [],
    });
  }

  /** unreadableCalls is how many calls were recorded as unreadable. */
  get unreadableCalls(): number {
    return this.#unreadable.length;
  }

  /**
   * apply sets res to what the unreadable calls mean: tool_error when no call
   * could be read, partial when some could, both with the reason code
   * tool_output_unreadable and a reason that names the raw output artifacts.
   * It adds the artifacts to res. It changes nothing when every call was
   * read, and it never replaces a status that is worse than partial: it only
   * adds the artifacts then.
   */
  apply(res: Result): void {
    const first = this.#unreadable[0];
    if (first === undefined) {
      return;
    }
    const artifacts = this.#unreadable.flatMap((u) => u.artifacts);
    res.artifacts = [...(res.artifacts ?? []), ...artifacts];
    if (res.status !== StatusCompleted && res.status !== StatusPartial) {
      return;
    }
    const total = this.#read + this.#unreadable.length;
    const tools = [...new Set(this.#unreadable.map((u) => u.tool))];
    let reason = `The output of ${tools.join(" and ")} could not be read: ${first.summary}`;
    if (first.where !== "") {
      reason += ` (${first.where})`;
    }
    reason +=
      total > 1
        ? `; ${String(this.#unreadable.length)} of ${String(total)} tool calls are affected.`
        : ".";
    const keptCalls = this.#unreadable.filter(
      (u) => u.artifacts.length > 0,
    ).length;
    const which =
      keptCalls === 1
        ? "that call are"
        : `the first ${String(keptCalls)} such calls are`;
    const raw = this.#unreadable.some((u) => u.files)
      ? "raw output"
      : "raw stdout and stderr";
    reason += ` The ${raw} of ${which} in ${artifacts.map((a) => quote(a.path)).join(", ")}. No Finding was made from them.`;
    if (res.status === StatusPartial && (res.reason ?? "") !== "") {
      reason += " Also: " + (res.reason ?? "");
    }
    res.status = this.#read > 0 ? StatusPartial : StatusToolError;
    res.reasonCode = "tool_output_unreadable";
    res.reason = reason;
  }
}

/**
 * unreadableResult is the Result of a Check whose only tool call printed
 * output that could not be read: res with the status tool_error, the reason
 * code tool_output_unreadable and the call's raw output as artifacts. Whatever
 * res already holds, such as the command and the tool, is kept; its Findings
 * are the adapter's to leave out. call names the call, as ToolOutputs.reject
 * wants it.
 */
export function unreadableResult(
  res: Result,
  checkID: string,
  contextID: string,
  tool: string,
  call: string,
  c: RawCall,
  summary: string,
  where = "",
): Result {
  const outputs = new ToolOutputs(checkID, contextID);
  outputs.reject(tool, call, c, summary, where);
  const out: Result = { ...res, status: StatusCompleted };
  delete out.reasonCode;
  delete out.reason;
  outputs.apply(out);
  return out;
}
