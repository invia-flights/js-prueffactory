// This file turns the JSON output of hadolint, ShellCheck and Redocly CLI into
// Findings (Go: repo_findings.go). Error-level
// results are errors, warnings are warnings, and the rest (info and style
// results) are notes. An error is a Gate only when the Check that reports it
// says so (ToolProblem.gate): under execution-v2 the files that hadolint,
// ShellCheck and Redocly examine do not run in the service, so none of their
// errors is.
import { quoteJSONString } from "../gocompat/json.ts";
import { goString, trimSpaceBytes } from "../gocompat/utf8.ts";
import { fields, trimSpace } from "../gocompat/strings.ts";
import { type Schema, type GoSlice, unmarshal } from "../gocompat/unmarshal.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  ConfidenceLikely,
  ConfidenceSuspected,
  type Finding,
  KindDefect,
  KindHint,
  SeverityError,
  SeverityNote,
  SeverityWarning,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { cutBytes, shorten } from "./cut_text.ts";
import { type Input, untrusted } from "./input.ts";
import type { ParseError } from "./artifacts_structured.ts";
import type { OpenAPITarget } from "./repo_targets.ts";
import { snapshotMount } from "./repo_tools.ts";
import { requireShape, shape, UnreadableOutput } from "./tool_output.ts";
import { errorMessage } from "../gocompat/errors.ts";
import { atoiClamped } from "../gocompat/strconv.ts";

/** projectPath turns a path a tool printed into a project-relative path. */
export function projectPath(p: string): string {
  if (p.startsWith(snapshotMount)) {
    p = p.slice(snapshotMount.length);
  }
  return p.startsWith("/") ? p.slice(1) : p;
}

/** ToolProblem is one result of a tool, in the terms the tools share. */
export interface ToolProblem {
  /** tool is "hadolint", "shellcheck", "redocly" or "helm". */
  tool: string;
  rule: string;
  /** level is "error", "warning" (or "warn"), "info" or "style". */
  level: string;
  /** path is project-relative. */
  path: string;
  line: number;
  column: number;
  message: string;
  /** raw is what the tool printed, as Evidence. */
  raw: string;
  /**
   * gate makes an error-level result a Gate. It is false unless the Check
   * says otherwise and has no effect on a result below error level.
   */
  gate?: boolean;
}

/**
 * repoFinding builds the Finding for one tool result. An error-level result
 * is a confirmed error; it is a Gate only when the Check asks for it, because
 * the Check knows whether the file it is about can fail the Run.
 */
export function repoFinding(
  input: Input,
  checkID: string,
  p: ToolProblem,
): Finding {
  const f = newFinding({
    check_id: checkID,
    context_id: input.context.id,
    rule_id: p.rule,
    fingerprint: newFingerprint(checkID, p.rule, p.path, p.message),
    kind: KindDefect,
    severity: SeverityNote,
    confidence: ConfidenceSuspected,
    title: cutTitle(p.rule + ": " + p.message),
    message: `${p.tool} reports ${levelWord(p.level)} ${p.rule}: ${p.message}`,
    locations: [input.location("primary", p.path, p.line, p.column)],
    evidence: [untrusted("tool_output", p.raw, p.tool)],
    reproduction: input.reproduction(checkID),
    limitations: [],
  });
  switch (p.level) {
    case "error":
      f.severity = SeverityError;
      f.confidence = ConfidenceConfirmed;
      f.gate = p.gate === true;
      break;
    case "warning":
    case "warn":
      f.severity = SeverityWarning;
      f.confidence = ConfidenceLikely;
      break;
    default:
      f.kind = KindHint;
  }
  return f;
}

function levelWord(level: string): string {
  return level === "warn" ? "warning" : level;
}

/** cutTitle collapses white space and cuts a title to about 120 bytes. */
export function cutTitle(s: string): string {
  return shorten(fields(s).join(" "), 120);
}

/** outputHead returns the first 200 bytes of the first non-empty output. */
export function outputHead(...outputs: string[]): string {
  for (const o of outputs) {
    const t = trimSpace(o);
    if (t !== "") {
      return cutBytes(t, 200);
    }
  }
  return "";
}

/**
 * outputHeadBytes is outputHead of raw tool output: trimmed and cut as bytes,
 * as Go does, and only then decoded, so that invalid UTF-8 counts one byte
 * each.
 */
export function outputHeadBytes(...outputs: Uint8Array[]): string {
  for (const o of outputs) {
    const t = trimSpaceBytes(o);
    if (t.length > 0) {
      let n = Math.min(t.length, 200);
      if (t.length > 200) {
        while (n > 0 && ((t[n] ?? 0) & 0xc0) === 0x80) {
          n--;
        }
      }
      return goString(t.subarray(0, n));
    }
  }
  return "";
}

// --- hadolint ---

interface HadolintResult {
  code: string;
  column: bigint;
  file: string;
  level: string;
  line: bigint;
  message: string;
}

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };

const hadolintSchema: Schema = {
  kind: "slice",
  type: '[]struct { Code string "json:\\"code\\""; Column int "json:\\"column\\""; File string "json:\\"file\\""; Level string "json:\\"level\\""; Line int "json:\\"line\\""; Message string "json:\\"message\\"" }',
  elem: {
    kind: "struct",
    type: 'struct { Code string "json:\\"code\\""; Column int "json:\\"column\\""; File string "json:\\"file\\""; Level string "json:\\"level\\""; Line int "json:\\"line\\""; Message string "json:\\"message\\"" }',
    fields: [
      { name: "code", schema: str },
      { name: "column", schema: int },
      { name: "file", schema: str },
      { name: "level", schema: str },
      { name: "line", schema: int },
      { name: "message", schema: str },
    ],
  },
};

/** hadolintShape is the array hadolint documents for `-f json`. */
const hadolintShape = shape.array(
  shape.object(
    {
      code: shape.string,
      file: shape.string,
      level: shape.string,
      line: shape.number,
      message: shape.string,
    },
    { column: shape.number },
  ),
);

/**
 * rawJSON is Go's json.Marshal of a decoded record: its fields in order, the
 * strings with HTML escaped.
 */
export function rawJSON(fieldsInOrder: [string, string | bigint][]): string {
  return (
    "{" +
    fieldsInOrder
      .map(
        ([k, v]) =>
          `"${k}":` +
          (typeof v === "bigint" ? v.toString() : quoteJSONString(v, true)),
      )
      .join(",") +
    "}"
  );
}

/**
 * hadolintFindings reads hadolint's `-f json` output, an array of results.
 * It throws for output that is not that JSON.
 */
export function hadolintFindings(input: Input, stdout: Uint8Array): Finding[] {
  let results: HadolintResult[];
  try {
    const decoded = unmarshal(stdout, hadolintSchema) as GoSlice | null;
    results = (decoded?.items() ?? []) as HadolintResult[];
  } catch (err) {
    throw new UnreadableOutput(
      `hadolint printed no JSON: ${errorMessage(err)}`,
      "it is not valid JSON of the expected kind",
      { cause: err },
    );
  }
  requireShape("hadolint", stdout, hadolintShape);
  return results.map((r) =>
    repoFinding(input, "repository.dockerfile", {
      tool: "hadolint",
      rule: r.code,
      level: r.level,
      path: projectPath(r.file),
      line: Number(r.line),
      column: Number(r.column),
      message: r.message,
      raw: rawJSON([
        ["code", r.code],
        ["column", r.column],
        ["file", r.file],
        ["level", r.level],
        ["line", r.line],
        ["message", r.message],
      ]),
    }),
  );
}

// --- ShellCheck ---

interface ShellcheckComment {
  file: string;
  line: bigint;
  column: bigint;
  level: string;
  code: bigint;
  message: string;
}

const shellcheckComment =
  'struct { File string "json:\\"file\\""; Line int "json:\\"line\\""; Column int "json:\\"column\\""; Level string "json:\\"level\\""; Code int "json:\\"code\\""; Message string "json:\\"message\\"" }';

const shellcheckSchema: Schema = {
  kind: "struct",
  type: `struct { Comments []${shellcheckComment} "json:\\"comments\\"" }`,
  fields: [
    {
      name: "comments",
      schema: {
        kind: "slice",
        type: "[]" + shellcheckComment,
        elem: {
          kind: "struct",
          type: shellcheckComment,
          fields: [
            { name: "file", schema: str },
            { name: "line", schema: int },
            { name: "column", schema: int },
            { name: "level", schema: str },
            { name: "code", schema: int },
            { name: "message", schema: str },
          ],
        },
      },
    },
  ],
};

/** shellcheckShape is the document ShellCheck documents for `-f json1`. */
const shellcheckShape = shape.object({
  comments: shape.array(
    shape.object({
      file: shape.string,
      line: shape.number,
      column: shape.number,
      level: shape.string,
      code: shape.number,
      message: shape.string,
    }),
  ),
});

/** scCode is Go's fmt.Sprintf("SC%04d", code). */
function scCode(code: bigint): string {
  const digits = (code < 0n ? -code : code).toString();
  const width = code < 0n ? 3 : 4;
  return "SC" + (code < 0n ? "-" : "") + digits.padStart(width, "0");
}

/**
 * shellcheckFindings reads ShellCheck's `-f json1` output. It throws for
 * output that is not that JSON.
 */
export function shellcheckFindings(
  input: Input,
  stdout: Uint8Array,
): Finding[] {
  let comments: ShellcheckComment[];
  try {
    const doc = unmarshal(stdout, shellcheckSchema) as {
      comments: GoSlice | null;
    };
    comments = (doc.comments?.items() ?? []) as ShellcheckComment[];
  } catch (err) {
    throw new UnreadableOutput(
      `shellcheck printed no JSON: ${errorMessage(err)}`,
      "it is not valid JSON of the expected kind",
      { cause: err },
    );
  }
  requireShape("shellcheck", stdout, shellcheckShape);
  return comments.map((c) =>
    repoFinding(input, "repository.shell", {
      tool: "shellcheck",
      rule: scCode(c.code),
      level: c.level,
      path: projectPath(c.file),
      line: Number(c.line),
      column: Number(c.column),
      message: c.message,
      raw: rawJSON([
        ["file", c.file],
        ["line", c.line],
        ["column", c.column],
        ["level", c.level],
        ["code", c.code],
        ["message", c.message],
      ]),
    }),
  );
}

// --- Redocly CLI ---

/**
 * RedoclyNoJSON is Redocly exiting without a JSON report, as it does when it
 * cannot read or parse a file. output is the first 200 bytes of what it
 * printed.
 */
export class RedoclyNoJSON extends UnreadableOutput {
  readonly output: string;
  /**
   * parseFailure is Redocly's documented "Failed to parse API description"
   * message, when that is what it printed instead of the report; null for any
   * other output. It is the one text that blames the file.
   */
  readonly parseFailure: RedoclyParseFailure | null;
  constructor(output: string, parseFailure: RedoclyParseFailure | null = null) {
    super(
      output === ""
        ? "redocly printed no JSON and nothing else"
        : "redocly printed no JSON, it said: " + output,
      "it is not the JSON report Redocly documents",
    );
    this.name = "RedoclyNoJSON";
    this.output = output;
    this.parseFailure = parseFailure;
  }
}

/**
 * RedoclyParseFailure is what Redocly prints when its YAML parser cannot read
 * the file, as 2.70.0 does on stderr with exit code 1:
 *
 *     validating openapi.yaml...
 *     Failed to parse API description at openapi.yaml:
 *
 *       - deficient indentation in "/snapshot/openapi.yaml" (6:1)
 */
export interface RedoclyParseFailure {
  /** message is the lines from the header on, as printed, cut to 400 bytes. */
  message: string;
  /** line and column are 1-based, 0 when the message names no position. */
  line: number;
  column: number;
}

const redoclyParseHeader = "Failed to parse API description";
// The position closes the first line of the reason: (line:col).
const redoclyPosition = /\(([0-9]+):([0-9]+)\)[.:]?$/;

/**
 * redoclyParseFailure finds Redocly's "Failed to parse API description"
 * message in what it printed, on either stream. Any other text is not it.
 */
export function redoclyParseFailure(
  ...outputs: Uint8Array[]
): RedoclyParseFailure | null {
  for (const out of outputs) {
    const lines = goString(out)
      .split("\n")
      .map((l) => trimSpace(l))
      .filter((l) => l !== "");
    const at = lines.findIndex((l) => l.startsWith(redoclyParseHeader));
    if (at < 0) {
      continue;
    }
    const message = lines.slice(at);
    const reason = message[1];
    const m = reason === undefined ? null : redoclyPosition.exec(reason);
    return {
      message: cutBytes(message.join("\n"), 400),
      line: m === null ? 0 : atoiClamped(m[1] ?? "0"),
      column: m === null ? 0 : atoiClamped(m[2] ?? "0"),
    };
  }
  return null;
}

/**
 * redoclyParseErrorFinding is the warning for a file that Redocly cannot read
 * and that the tool's own parser of artifacts.structured accepts: the readers
 * disagree about the file. parser names that native parser, "YAML" or
 * "JSON". Redocly's words are Evidence and are not repeated in the message.
 */
export function redoclyParseErrorFinding(
  input: Input,
  target: OpenAPITarget,
  failure: RedoclyParseFailure,
  parser: "YAML" | "JSON",
): Finding {
  return repoFinding(input, "api.lint", {
    tool: "redocly",
    rule: "redocly-parse-error",
    level: "warning",
    path: target.path,
    line: failure.line,
    column: failure.column,
    message: `Redocly cannot parse the file, but the tool's own ${parser} parser accepts the file, so ${parser === "YAML" ? "YAML" : "JSON and YAML"} readers disagree on it`,
    raw: failure.message,
  });
}

/** redoclyShape is the report Redocly documents for `lint --format json`. */
const redoclyShape = shape.object({
  problems: shape.array(
    shape.object(
      {
        ruleId: shape.string,
        severity: shape.string,
        message: shape.string,
      },
      {
        location: shape.nullable(
          shape.array(
            shape.object(
              {},
              {
                start: shape.object({ line: shape.number, col: shape.number }),
              },
            ),
          ),
        ),
      },
    ),
  ),
});

/**
 * unparseableFinding is the error for an OpenAPI file that is not valid YAML
 * or JSON, reported when artifacts.structured is not there to report it. It
 * is no Gate; artifacts.structured's Finding for the same file is.
 */
export function unparseableFinding(
  input: Input,
  target: OpenAPITarget,
  perr: ParseError,
  output: string,
): Finding {
  return repoFinding(input, "api.lint", {
    tool: "redocly",
    rule: "unparseable",
    level: "error",
    path: target.path,
    line: perr.line,
    column: perr.column,
    message: "the file is not valid YAML or JSON, so it cannot be linted",
    raw: output,
  });
}

interface RedoclyProblem {
  ruleId: string;
  severity: string;
  message: string;
  location: GoSlice | null;
}

interface RedoclyLocation {
  start: { line: bigint; col: bigint };
}

const redoclyStart =
  'struct { Line int "json:\\"line\\""; Col int "json:\\"col\\"" }';
const redoclyLocation = `struct { Start ${redoclyStart} "json:\\"start\\"" }`;
const redoclyProblem = `struct { RuleID string "json:\\"ruleId\\""; Severity string "json:\\"severity\\""; Message string "json:\\"message\\""; Location []${redoclyLocation} "json:\\"location\\"" }`;

const redoclySchema: Schema = {
  kind: "struct",
  type: `struct { Problems []${redoclyProblem} "json:\\"problems\\"" }`,
  fields: [
    {
      name: "problems",
      schema: {
        kind: "slice",
        type: "[]" + redoclyProblem,
        elem: {
          kind: "struct",
          type: redoclyProblem,
          fields: [
            { name: "ruleId", schema: str },
            { name: "severity", schema: str },
            { name: "message", schema: str },
            {
              name: "location",
              schema: {
                kind: "slice",
                type: "[]" + redoclyLocation,
                elem: {
                  kind: "struct",
                  type: redoclyLocation,
                  fields: [
                    {
                      name: "start",
                      schema: {
                        kind: "struct",
                        type: redoclyStart,
                        fields: [
                          { name: "line", schema: int },
                          { name: "col", schema: int },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
  ],
};

/** redoclyRaw is Go's json.Marshal of one decoded Redocly problem. */
function redoclyRaw(p: RedoclyProblem): string {
  const q = (s: string) => quoteJSONString(s, true);
  const locations =
    p.location === null
      ? "null"
      : "[" +
        (p.location.items() as RedoclyLocation[])
          .map(
            (l) =>
              `{"start":{"line":${l.start.line.toString()},"col":${l.start.col.toString()}}}`,
          )
          .join(",") +
        "]";
  return `{"ruleId":${q(p.ruleId)},"severity":${q(p.severity)},"message":${q(p.message)},"location":${locations}}`;
}

/**
 * redoclyFindings reads `redocly lint --format json` output for one file.
 * For a file with a remote $ref it drops the failures to fetch that
 * reference, since the Execution phase has no network: the caller records a
 * Limitation instead. It throws RedoclyNoJSON for output that is not that
 * JSON.
 */
export function redoclyFindings(
  input: Input,
  target: OpenAPITarget,
  stdout: Uint8Array,
  stderr: Uint8Array,
): Finding[] {
  let problems: RedoclyProblem[];
  try {
    const doc = unmarshal(stdout, redoclySchema) as {
      problems: GoSlice | null;
    };
    problems = (doc.problems?.items() ?? []) as RedoclyProblem[];
  } catch {
    throw new RedoclyNoJSON(
      outputHeadBytes(stderr, stdout),
      redoclyParseFailure(stderr, stdout),
    );
  }
  requireShape("redocly", stdout, redoclyShape);
  const out: Finding[] = [];
  for (const p of problems) {
    if (
      target.remoteRef &&
      p.ruleId === "no-unresolved-refs" &&
      p.message.includes("fetch failed")
    ) {
      continue;
    }
    const first = p.location?.items()[0] as RedoclyLocation | undefined;
    out.push(
      repoFinding(input, "api.lint", {
        tool: "redocly",
        rule: p.ruleId,
        level: p.severity,
        path: target.path,
        line: first === undefined ? 0 : Number(first.start.line),
        column: first === undefined ? 0 : Number(first.start.col),
        message: p.message,
        raw: redoclyRaw(p),
      }),
    );
  }
  return out;
}
