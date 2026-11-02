// This file turns the JSON output of hadolint and ShellCheck into Findings
// (Go: repo_findings.go; its Redocly part arrives with api.lint). Error-level
// results are Gates, warnings are warnings, and the rest (info and style
// results) are notes.
import { quoteJSONString } from "../gocompat/json.ts";
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
import { snapshotMount } from "./repo_tools.ts";

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
}

/** repoFinding builds the Finding for one tool result. */
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
      f.gate = true;
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

/**
 * rawJSON is Go's json.Marshal of a decoded record: its fields in order, the
 * strings with HTML escaped.
 */
function rawJSON(fieldsInOrder: [string, string | bigint][]): string {
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

/** errorText is the message of a thrown value, as Go's %v of an error. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    throw new Error(`hadolint printed no JSON: ${errorText(err)}`, {
      cause: err,
    });
  }
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
    throw new Error(`shellcheck printed no JSON: ${errorText(err)}`, {
      cause: err,
    });
  }
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
