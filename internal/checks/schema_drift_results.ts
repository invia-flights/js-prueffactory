// What the generators and the compare helper of schema.drift left, turned
// into Findings, diff artifacts and Limitations (Go: schema_drift_results.go).
import { createHash } from "node:crypto";

import type { GeneratorScript } from "../discovery/generators.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { base, clean, isAbs, join } from "../gocompat/path.ts";
import { compareBytes } from "../gocompat/strings.ts";
import { checkValid, unquote } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  type Artifact,
  ConfidenceConfirmed,
  type Evidence,
  type Finding,
  KindDefect,
  KindHint,
  type Limitation,
  MaxEvidenceBytes,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { newArtifact, newFinding } from "../resultset/zero.ts";
import { cutList } from "./cut_text.ts";
import { unifiedDiff } from "./schema_drift_diff.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { errTooLarge, maxProjectFileBytes, readCapped } from "./readcap.ts";
import { shownPath, shownWord } from "./shown_text.ts";

export const schemaDriftID = "schema.drift";

export const ruleDriftChanged = "schema-drift.changed";
export const ruleDriftCreated = "schema-drift.created";
export const ruleDriftFailed = "schema-drift.generator-failed";

/**
 * driftDiffCap is the most bytes of a diff artifact. A longer diff is cut at
 * a line and says so.
 */
export const driftDiffCap = 256 << 10;
/** driftOutputTail is how much of a failed generator's output is kept. */
const driftOutputTail = 4096;
/**
 * driftMaxFindings caps the Findings of each kind in one package, so that a
 * generator that rewrites thousands of files cannot flood the Report.
 */
const driftMaxFindings = 200;

const reasonDriftTooLarge = "files_too_large_to_compare";
const reasonDriftCut = "findings_cut";

/**
 * DriftCompareOutput is what the compare helper of the generators' copy
 * reports: the files whose content the generators changed.
 */
export interface DriftCompareOutput {
  /**
   * changed holds the files that exist in the Snapshot with other bytes
   * than the generators left, with the generated content.
   */
  changed: DriftFile[];
  /** created holds the files the generators made that the Snapshot lacks. */
  created: DriftFile[];
}

/** DriftFile is one file of the compare helper's report. */
export interface DriftFile {
  /** path is relative to the project root, with forward slashes. */
  path: string;
  size: bigint;
  /**
   * content is the generated content in base64. It is empty for a created
   * file, and for a file the helper left unread because of tooLarge.
   */
  content: string;
  too_large: boolean;
}

/** DriftFailure is a generator script that exited with an error. */
export interface DriftFailure {
  script: GeneratorScript;
  exitCode: number;
  oom: boolean;
  /** output is what the script wrote, standard output and then standard error. */
  output: Uint8Array;
}

/**
 * driftResult turns what the generators and the compare helper left into
 * the Check's Result. scripts are all the generator scripts that ran, in
 * order.
 */
export function driftResult(
  input: Input,
  scripts: readonly GeneratorScript[],
  failures: readonly DriftFailure[],
  out: DriftCompareOutput,
): Result {
  const findings: Finding[] = [];
  const artifacts: Artifact[] = [];
  const limitations: Limitation[] = [];
  const res: Result = { status: StatusCompleted };
  const names = shownScriptNames(scripts);

  const changed = [...out.changed].sort((a, b) => compareBytes(a.path, b.path));
  const tooLarge: string[] = [];
  let cut = 0;
  let nChanged = 0;
  const used = new Set<string>();
  for (const f of changed) {
    if (!validDriftPath(f.path)) {
      continue;
    }
    if (f.too_large) {
      tooLarge.push(f.path);
      continue;
    }
    const generatedBytes = decodeStdBase64(f.content);
    if (generatedBytes === undefined) {
      continue;
    }
    let committed: Uint8Array;
    try {
      committed = readCapped(
        join(input.snapshotDir, f.path),
        maxProjectFileBytes,
      );
    } catch (err) {
      if (err === errTooLarge) {
        tooLarge.push(f.path);
      }
      continue;
    }
    const [diff, differs] = driftDiff(f.path, committed, generatedBytes);
    if (!differs) {
      continue;
    }
    if (++nChanged > driftMaxFindings) {
      cut++;
      continue;
    }
    const artifact = driftDiffArtifact(input.context.id, f.path, diff, used);
    artifacts.push(artifact);
    findings.push(driftChangedFinding(input, f.path, names, artifact));
  }

  const created = [...out.created].sort((a, b) => compareBytes(a.path, b.path));
  let nCreated = 0;
  for (const f of created) {
    if (!validDriftPath(f.path)) {
      continue;
    }
    if (++nCreated > driftMaxFindings) {
      cut++;
      continue;
    }
    findings.push(driftCreatedFinding(input, f.path, names));
  }

  for (const fl of failures) {
    findings.push(driftFailedFinding(input, fl));
  }
  const firstFailure = failures[0];
  if (firstFailure !== undefined) {
    res.status = StatusPartial;
    res.reasonCode = "generator_failed";
    res.reason = `${String(failures.length)} of ${String(scripts.length)} generator script(s) failed, for example ${shownWord(firstFailure.script.name, "script name")}; the cause may be missing network or credentials, so the drift of this package is unknown`;
  }
  if (tooLarge.length > 0) {
    limitations.push({
      reason_code: reasonDriftTooLarge,
      check_id: schemaDriftID,
      path: null,
      message: `${String(tooLarge.length)} changed file(s) are over ${String(maxProjectFileBytes >> 20)} MiB and were not compared: ${cutList(tooLarge.map(shownPath), 20).join(", ")}`,
    });
  }
  if (cut > 0) {
    limitations.push({
      reason_code: reasonDriftCut,
      check_id: schemaDriftID,
      path: null,
      message: `${String(cut)} Finding(s) were left out: a package reports at most ${String(driftMaxFindings)} changed and ${String(driftMaxFindings)} created files`,
    });
  }
  if (findings.length > 0) res.findings = findings;
  if (artifacts.length > 0) res.artifacts = artifacts;
  if (limitations.length > 0) res.limitations = limitations;
  return res;
}

/**
 * decodeStdBase64 is Go's base64.StdEncoding.DecodeString: padded, the
 * standard alphabet, line feeds and carriage returns ignored. It returns
 * undefined where Go returns an error.
 */
function decodeStdBase64(s: string): Uint8Array | undefined {
  const t = s.replace(/[\r\n]/g, "");
  if (
    t.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(t)
  ) {
    return undefined;
  }
  return Buffer.from(t, "base64");
}

/**
 * validDriftPath says whether a path the compare helper reported can be
 * joined with the Snapshot's folder: a clean relative path that stays
 * inside it. Go also asks for valid UTF-8, which a string decoded from
 * JSON always is.
 */
function validDriftPath(p: string): boolean {
  return (
    p !== "" &&
    p !== "." &&
    clean(p) === p &&
    !isAbs(p) &&
    p !== ".." &&
    !p.startsWith("../") &&
    !p.includes("\\")
  );
}

/**
 * shownScriptNames lists the generator scripts for trusted text. A name that
 * is not a plain word is replaced by a placeholder.
 */
function shownScriptNames(scripts: readonly GeneratorScript[]): string {
  return cutList(
    scripts.map((s) => shownWord(s.name, "script name")),
    5,
  ).join(", ");
}

// --- comparing ---

/** utf8ByteString is a text's UTF-8 encoding as a byte string. */
function utf8ByteString(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/**
 * driftDiff compares a committed file with what the generators left. When
 * both parse as JSON they are equal if their parsed values are, and the diff
 * shows both with sorted keys and fixed indentation, so that formatting never
 * hides or adds a line. Otherwise the bytes are compared and the diff shows
 * them as they are. It returns the unified diff as a byte string, and whether
 * the files differ.
 */
export function driftDiff(
  rel: string,
  committed: Uint8Array,
  generated: Uint8Array,
): [diff: string, differs: boolean] {
  const header = utf8ByteString(cleanForHeader(rel));
  const oldName = "a/" + header;
  const newName = "b/" + header;
  const a = parseJSONValue(committed);
  if (a !== undefined) {
    const b = parseJSONValue(generated);
    if (b !== undefined) {
      if (jsonValuesEqual(a.value, b.value)) {
        return ["", false];
      }
      return [
        unifiedDiff(
          oldName,
          newName,
          utf8ByteString(canonicalJSON(a.value)),
          utf8ByteString(canonicalJSON(b.value)),
        ),
        true,
      ];
    }
  }
  if (Buffer.from(committed).equals(generated)) {
    return ["", false];
  }
  if (committed.includes(0) || generated.includes(0)) {
    return [`Binary files ${oldName} and ${newName} differ\n`, true];
  }
  return [
    unifiedDiff(
      oldName,
      newName,
      Buffer.from(committed).toString("latin1"),
      Buffer.from(generated).toString("latin1"),
    ),
    true,
  ];
}

/**
 * cleanForHeader keeps a path with a line break or another control
 * character from breaking the lines of a diff header.
 */
function cleanForHeader(p: string): string {
  let out = "";
  for (const ch of p) {
    const r = ch.codePointAt(0) ?? 0;
    out += r < 0x20 || r === 0x7f ? "?" : ch;
  }
  return out;
}

/** JSONNumber is a parsed JSON number that keeps its text (Go: json.Number). */
class JSONNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type JSONValue =
  null | boolean | string | JSONNumber | JSONValue[] | Map<string, JSONValue>;

/**
 * parseJSONValue parses a document that is one JSON value, with an optional
 * byte order mark. Numbers keep their text. A repeated key keeps its last
 * value. It returns undefined for anything else. The parse uses its own
 * stack, so deep nesting cannot overflow the call stack.
 */
function parseJSONValue(data: Uint8Array): { value: JSONValue } | undefined {
  if (
    data.length >= 3 &&
    data[0] === 0xef &&
    data[1] === 0xbb &&
    data[2] === 0xbf
  ) {
    data = data.subarray(3);
  }
  if (checkValid(data) !== undefined) {
    return undefined;
  }
  // data is one valid JSON value: what follows only needs to find its parts.
  type Frame =
    | { kind: "array"; items: JSONValue[] }
    | { kind: "object"; entries: Map<string, JSONValue>; key: string };
  const stack: Frame[] = [];
  let i = 0;
  const skipSpace = () => {
    while (
      i < data.length &&
      (data[i] === 0x20 ||
        data[i] === 0x09 ||
        data[i] === 0x0a ||
        data[i] === 0x0d)
    ) {
      i++;
    }
  };
  const stringEnd = (start: number): number => {
    let j = start + 1;
    while (data[j] !== 0x22) {
      j += data[j] === 0x5c ? 2 : 1;
    }
    return j + 1;
  };
  for (;;) {
    skipSpace();
    let value: JSONValue;
    const c = data[i];
    if (c === 0x7b) {
      i++;
      skipSpace();
      if (data[i] === 0x7d) {
        i++;
        value = new Map();
      } else {
        const end = stringEnd(i);
        const key = unquote(data, i, end);
        i = end;
        skipSpace();
        i++; // the colon
        stack.push({ kind: "object", entries: new Map(), key });
        continue;
      }
    } else if (c === 0x5b) {
      i++;
      skipSpace();
      if (data[i] === 0x5d) {
        i++;
        value = [];
      } else {
        stack.push({ kind: "array", items: [] });
        continue;
      }
    } else if (c === 0x22) {
      const end = stringEnd(i);
      value = unquote(data, i, end);
      i = end;
    } else if (c === 0x74) {
      i += 4;
      value = true;
    } else if (c === 0x66) {
      i += 5;
      value = false;
    } else if (c === 0x6e) {
      i += 4;
      value = null;
    } else {
      const start = i;
      while (i < data.length && isNumberByte(data[i] ?? 0)) {
        i++;
      }
      value = new JSONNumber(
        Buffer.from(data.subarray(start, i)).toString("latin1"),
      );
    }
    // Hand the value to its container, closing every container it ends.
    for (;;) {
      const top = stack.at(-1);
      if (top === undefined) {
        return { value };
      }
      if (top.kind === "array") {
        top.items.push(value);
      } else {
        top.entries.delete(top.key);
        top.entries.set(top.key, value);
      }
      skipSpace();
      if (data[i] === 0x2c) {
        i++;
        if (top.kind === "object") {
          skipSpace();
          const end = stringEnd(i);
          top.key = unquote(data, i, end);
          i = end;
          skipSpace();
          i++; // the colon
        }
        break;
      }
      i++; // the closing bracket or brace
      stack.pop();
      value = top.kind === "array" ? top.items : top.entries;
    }
  }
}

/** isNumberByte says whether c can be part of a JSON number. */
function isNumberByte(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2d ||
    c === 0x2b ||
    c === 0x2e ||
    c === 0x65 ||
    c === 0x45
  );
}

/**
 * jsonValuesEqual compares parsed values: objects by key and never by order,
 * arrays by order, numbers by value.
 */
function jsonValuesEqual(a: JSONValue, b: JSONValue): boolean {
  const pending: [JSONValue, JSONValue][] = [[a, b]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [x, y] = pair;
    if (x instanceof Map) {
      if (!(y instanceof Map) || x.size !== y.size) return false;
      for (const [k, xv] of x) {
        if (!y.has(k)) return false;
        pending.push([xv, y.get(k) ?? null]);
      }
    } else if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      x.forEach((xv, i) => pending.push([xv, y[i] ?? null]));
    } else if (x instanceof JSONNumber) {
      if (!(y instanceof JSONNumber) || !numbersEqual(x.text, y.text)) {
        return false;
      }
    } else if (x !== y) {
      return false;
    }
  }
  return true;
}

/**
 * numbersEqual compares two JSON numbers by value, so that 1 and 1.0 are
 * equal and integers beyond what a float holds still compare exactly. A
 * number with an exponent, or a very long one, is compared as a float: an
 * exponent could ask for an exact value of unbounded size.
 */
function numbersEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const maxExact = 64;
  if (a.length <= maxExact && b.length <= maxExact && !/[eE]/.test(a + b)) {
    return exactDecimal(a) === exactDecimal(b);
  }
  const x = Number(a);
  const y = Number(b);
  // Go's Float64 fails for a value out of range.
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * exactDecimal is the canonical text of a JSON number without an exponent:
 * no leading zeros, no trailing fraction zeros, no sign for zero.
 */
function exactDecimal(n: string): string {
  const negative = n.startsWith("-");
  const [intPart = "", frac = ""] = (negative ? n.slice(1) : n).split(".");
  const i = intPart.replace(/^0+/, "");
  const f = frac.replace(/0+$/, "");
  if (i === "" && f === "") {
    return "0";
  }
  return (
    (negative ? "-" : "") + (i === "" ? "0" : i) + (f === "" ? "" : "." + f)
  );
}

/**
 * canonicalJSON writes a parsed value with sorted keys and two-space
 * indentation, the numbers as they were written, HTML characters unescaped,
 * and a final line feed (Go: json.Encoder with SetIndent).
 */
function canonicalJSON(v: JSONValue): string {
  const parts: string[] = [];
  // Work items: a value at an indentation level, or a literal text.
  const work: (string | { v: JSONValue; indent: string })[] = [
    { v, indent: "" },
  ];
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const { v: x, indent } = item;
    const inner = indent + "  ";
    if (x instanceof Map) {
      if (x.size === 0) {
        parts.push("{}");
        continue;
      }
      const keys = [...x.keys()].sort(compareBytes);
      const next: (string | { v: JSONValue; indent: string })[] = ["{"];
      keys.forEach((k, i) => {
        next.push(
          (i === 0 ? "\n" : ",\n") + inner + quoteJSONString(k, false) + ": ",
          { v: x.get(k) ?? null, indent: inner },
        );
      });
      next.push("\n" + indent + "}");
      work.push(...next.reverse());
    } else if (Array.isArray(x)) {
      if (x.length === 0) {
        parts.push("[]");
        continue;
      }
      const next: (string | { v: JSONValue; indent: string })[] = ["["];
      x.forEach((e, i) => {
        next.push(i === 0 ? "\n" + inner : ",\n" + inner, {
          v: e,
          indent: inner,
        });
      });
      next.push("\n" + indent + "]");
      work.push(...next.reverse());
    } else if (x instanceof JSONNumber) {
      parts.push(x.text);
    } else if (typeof x === "string") {
      parts.push(quoteJSONString(x, false));
    } else {
      parts.push(x === null ? "null" : x ? "true" : "false");
    }
  }
  return parts.join("") + "\n";
}

// --- artifacts and Findings ---

/** byteRuneStart is utf8.RuneStart. */
function byteRuneStart(c: number): boolean {
  return (c & 0xc0) !== 0x80;
}

/** cutByteString is cutBytes on a byte string. */
function cutByteString(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  while (n > 0 && !byteRuneStart(s.charCodeAt(n))) {
    n--;
  }
  return s.slice(0, n);
}

/**
 * driftDiffArtifact is the diff of one file as an artifact. Its path is made
 * of a hash of the file's path and a cleaned-up file name, so that no
 * project text with odd characters reaches the report folder's layout and
 * two files with the same name never share a path. The ID is a key that the
 * engine replaces and the Finding's Evidence refers to. diff is a byte
 * string.
 */
export function driftDiffArtifact(
  contextID: string,
  rel: string,
  diff: string,
  used: Set<string>,
): Artifact {
  const hash = createHash("sha256").update(rel, "utf8").digest("hex");
  let name = base(rel).replace(/[^A-Za-z0-9._-]+/g, "_");
  if (name.length > 60) {
    name = name.slice(0, 60);
  }
  let n = 8;
  while (used.has(hash.slice(0, n)) && n < hash.length) {
    n++;
  }
  const key = hash.slice(0, n);
  used.add(key);
  const [content, truncated] = capDiff(diff);
  return newArtifact({
    id: "diff-" + key,
    path: `artifacts/${schemaDriftID}/${contextID}/${key}-${name}.diff`,
    media_type: "text/x-diff",
    content: Buffer.from(content, "latin1"),
    truncated,
  });
}

/**
 * capDiff cuts a diff over driftDiffCap at a line and ends it with a note,
 * so that the result, note included, stays within the cap.
 */
function capDiff(diff: string): [string, boolean] {
  if (diff.length <= driftDiffCap) {
    return [diff, false];
  }
  const note = "\\ [the diff was cut at 256 KiB]\n";
  let cut = driftDiffCap - note.length;
  const i = diff.lastIndexOf("\n", cut - 1);
  if (i >= 0) {
    cut = i + 1;
  }
  return [diff.slice(0, cut) + note, true];
}

/** driftContinues ends the Evidence of a diff that goes on in its artifact. */
export const driftContinues = "\n[the diff continues in the artifact]\n";

/**
 * driftEvidence is the diff as untrusted Evidence: the start of it as text,
 * the whole of it behind the artifact. The cut is marked in the text and not
 * by an original size, because redaction can change the artifact's size
 * before the Report is finished, and the Report's validation compares the
 * two.
 */
export function driftEvidence(a: Artifact): Evidence {
  let text = Buffer.from(a.content ?? new Uint8Array()).toString("latin1");
  if (text.length > MaxEvidenceBytes) {
    text =
      cutByteString(text, MaxEvidenceBytes - driftContinues.length) +
      driftContinues;
  }
  const ev = untrusted(
    "diff",
    goString(Buffer.from(text, "latin1")),
    schemaDriftID,
  );
  ev.artifact_id = a.id;
  return ev;
}

/**
 * driftFinding is a confirmed warning at a file of the project. The key
 * tells apart Findings of one rule at one file.
 */
function driftFinding(
  input: Input,
  rule: string,
  rel: string,
  key: string,
): Finding {
  return newFinding({
    check_id: schemaDriftID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(schemaDriftID, rule, rel, key),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceConfirmed,
    locations: [input.location("primary", rel, 0, 0)],
    reproduction: input.reproduction(schemaDriftID),
    limitations: [],
  });
}

function driftChangedFinding(
  input: Input,
  rel: string,
  scripts: string,
  diff: Artifact,
): Finding {
  const f = driftFinding(input, ruleDriftChanged, rel, "");
  f.title = "Committed file differs from what its generator produces";
  f.message = `Running the generator script(s) ${scripts} of this package in a separate copy changes the content of ${shownPath(rel)}, so the committed file was not regenerated after its source changed. JSON files are compared as parsed values, so formatting and key order are not the cause. The unified diff is in the Evidence.`;
  f.evidence = [driftEvidence(diff)];
  return f;
}

/** packageManifest is the project path of the package.json that names the generators. */
function packageManifest(input: Input): string {
  return join(input.context.package?.path ?? ".", "package.json");
}

function driftCreatedFinding(
  input: Input,
  rel: string,
  scripts: string,
): Finding {
  // The file is not in the project, so the location is the package.json
  // that names the generators, and the file's own path is Evidence.
  const f = driftFinding(input, ruleDriftCreated, packageManifest(input), rel);
  f.kind = KindHint;
  f.severity = SeverityNote;
  f.title = "Generator creates a file that is not committed";
  f.message = `Running the generator script(s) ${scripts} of this package in a separate copy creates ${shownPath(rel)}, which is not among the project's files. Commit it, or let the project ignore it.`;
  f.evidence = [untrusted("created_file", rel, schemaDriftID)];
  return f;
}

/** lastBytesOf is lastBytes on raw bytes, decoded as Go's JSON encoder does. */
function lastBytesOf(b: Uint8Array, n: number): string {
  let start = Math.max(b.length - n, 0);
  if (b.length > n) {
    while (start < b.length && !byteRuneStart(b[start] ?? 0)) {
      start++;
    }
  }
  return goString(b.subarray(start));
}

function driftFailedFinding(input: Input, fl: DriftFailure): Finding {
  const f = driftFinding(
    input,
    ruleDriftFailed,
    packageManifest(input),
    fl.script.name,
  );
  f.title = "Generator script failed";
  const how = fl.oom
    ? "ran out of memory"
    : `exited with code ${String(fl.exitCode)}`;
  f.message = `The generator script ${shownWord(fl.script.name, "script name")} ${how}, so its files could not be compared with the committed ones. The Run gives its generators no network and no credentials, which is a likely cause. The last 4 KiB of its output is in the Evidence.`;
  f.evidence = [
    untrusted("tool_output", lastBytesOf(fl.output, driftOutputTail), "node"),
  ];
  return f;
}
