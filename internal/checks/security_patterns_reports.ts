import { createHash } from "node:crypto";

import { clean, join } from "../gocompat/path.ts";
import { compareBytes, isSpace, sortStrings } from "../gocompat/strings.ts";
import { GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { toByteString } from "../gocompat/neturl.ts";
import { decodeRune, goString } from "../gocompat/utf8.ts";
import {
  FingerprintV1,
  type Finding,
  KindSuspicion,
  SeverityWarning,
  ConfidenceLikely,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Input, untrusted } from "./input.ts";
import { readProjectFile } from "./readcap.ts";
import { cutTitle } from "./repo_findings.ts";
import { unmarshalText } from "./security_dependencies_osv.ts";
import {
  latin1,
  patternsID,
  patternsMount,
} from "./security_patterns_scope.ts";

/** spotOf is the file, line and column a Finding starts at. */
export function spotOf(f: Finding): string {
  const l = f.locations[0];
  const line = l?.start?.line ?? 0;
  const col = l?.start?.column ?? 0;
  return `${l?.path ?? ""}\x00${String(line)}\x00${String(col)}`;
}

interface ScanError {
  path: string;
  message: string;
}

/**
 * patternsProjectPath maps a file path of a report to a project path, or
 * undefined for a path outside the scan folder.
 */
function patternsProjectPath(input: Input, p: string): string | undefined {
  if (!p.startsWith(patternsMount + "/")) {
    return undefined;
  }
  let rel = p.slice(patternsMount.length + 1);
  if (rel === "") {
    return undefined;
  }
  rel = clean(rel);
  if (rel === "." || rel === ".." || rel.startsWith("../")) {
    return undefined;
  }
  return join(input.context.package?.path ?? ".", rel);
}

/**
 * unparsedPaths turns the errors of a report into project paths. An error
 * that names no file is listed as it was said; those notes are returned
 * apart, because they are the tool's text and no path.
 */
function unparsedPaths(
  input: Input,
  errs: readonly ScanError[],
): [paths: string[], notes: string[]] {
  const paths: string[] = [];
  const notes: string[] = [];
  for (const e of errs) {
    const p = patternsProjectPath(input, e.path);
    if (p !== undefined) {
      paths.push(p);
    } else if (e.message !== "") {
      notes.push(cutTitle(e.message));
    }
  }
  return [mergeSorted(paths), mergeSorted(notes)];
}

/** Reading is what a report reader hands back: Findings, and the files and notes of what it could not parse. */
export interface Reading {
  findings: Finding[];
  paths: string[];
  notes: string[];
}

/** mergeSorted returns the sorted union of lists, without duplicates. */
export function mergeSorted(...lists: (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compareBytes);
}

/** PatternHit is a hit of either tool, in the terms they share. */
export interface PatternHit {
  /** rule has its source prefix. */
  rule: string;
  /** path is project-relative. */
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  description: string;
  /** matched is the matched source text, as a byte string. */
  matched: string;
}

/**
 * fingerprintOf is resultset.NewFingerprint over a text held as a byte
 * string, so that bytes that are no UTF-8 are hashed as Go hashes them.
 */
function fingerprintOf(
  checkID: string,
  rule: string,
  path: string,
  text: string,
) {
  const norm = byteFields(
    text.replace(/(:\d+(:\d+)?|\bline \d+(, column \d+)?|\bcolumn \d+)/gi, ""),
  ).join(" ");
  const h = createHash("sha256");
  for (const part of [checkID, rule, path]) {
    h.update(part, "utf8");
    h.update(Buffer.of(0));
  }
  h.update(Buffer.from(norm, "latin1"));
  h.update(Buffer.of(0));
  return { algorithm: FingerprintV1, value: h.digest("hex") };
}

// byteFields is strings.Fields over a byte string: runes are decoded from
// the bytes, a byte that is no UTF-8 is no space.
function byteFields(s: string): string[] {
  const b = Buffer.from(s, "latin1");
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < b.length;) {
    const [r, size] = decodeRune(b, i);
    const space = isSpace(r) && !(r === 0xfffd && size === 1);
    if (space) {
      if (start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
    i += size;
  }
  if (start >= 0) {
    out.push(s.slice(start));
  }
  return out;
}

/** patternFinding builds the Finding for one hit. */
export function patternFinding(
  input: Input,
  h: PatternHit,
  tool: string,
  ordinal: number,
): Finding {
  const loc = input.location("primary", h.path, h.line, h.col);
  if (h.endLine > 0) {
    loc.end = { line: h.endLine, column: h.endCol > 0 ? h.endCol : null };
  }
  let text = h.matched;
  if (ordinal > 1) {
    text += " #" + String(ordinal);
  }
  const f = newFinding({
    check_id: patternsID,
    context_id: input.context.id,
    rule_id: h.rule,
    fingerprint: fingerprintOf(patternsID, h.rule, h.path, text),
    kind: KindSuspicion,
    severity: SeverityWarning,
    confidence: ConfidenceLikely,
    title: cutTitle(h.rule + ": " + h.description),
    message: h.message,
    locations: [loc],
    evidence: [],
    reproduction: input.reproduction(patternsID),
    limitations: [],
  });
  if (h.matched !== "") {
    f.evidence.push(
      untrusted(
        "tool_output",
        goString(Buffer.from(h.matched, "latin1")),
        tool,
      ),
    );
  }
  return f;
}

/**
 * patternFindings turns hits into Findings, numbering repeated hits of one
 * rule on one text so that their fingerprints differ.
 */
function patternFindings(
  input: Input,
  hits: readonly PatternHit[],
  tool: string,
): Finding[] {
  const seen = new Map<string, number>();
  return hits.map((h) => {
    const key = `${h.rule}\x00${h.path}\x00${h.matched}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return patternFinding(input, h, tool, n);
  });
}

/**
 * patternsOverlap maps a tool-owned rule to the njsscan rules that describe
 * the same weakness. Both fire on the same call, and one insecure spot must
 * be one Finding.
 *
 * Only rules that describe the same weakness are paired. njsscan's other
 * rules that fire on the same spot, such as express_xss on
 * `res.send(String(eval(x)))`, name another weakness and stay.
 */
const patternsOverlap = new Map<string, string[]>([
  [
    "prueffactory/weak-hash-md5-sha1",
    ["njsscan/node_md5", "njsscan/node_sha1"],
  ],
  [
    "prueffactory/child-process-exec-non-literal",
    ["njsscan/generic_os_command_exec"],
  ],
  ["prueffactory/eval-non-literal", ["njsscan/eval_nodejs"]],
]);

/**
 * mergeOverlappingHits drops an njsscan Finding that a tool-owned rule of
 * the same weakness reports at the same file, line and column, and names the
 * dropped rule in the Message of the tool-owned Finding, whose rule and
 * Message are the tool's own. Everything else, in its order, stays.
 */
export function mergeOverlappingHits(fs: readonly Finding[]): Finding[] {
  // spot + njsscan rule -> index of the tool-owned Finding; a later one wins,
  // as in Go's map.
  const owners = new Map<string, number>();
  fs.forEach((f, i) => {
    for (const njs of patternsOverlap.get(f.rule_id ?? "") ?? []) {
      owners.set(spotOf(f) + "\x00" + njs, i);
    }
  });
  const merged = new Map<number, string[]>();
  const dropped = new Set<number>();
  fs.forEach((f, i) => {
    const owner = owners.get(spotOf(f) + "\x00" + (f.rule_id ?? ""));
    if (owner !== undefined) {
      dropped.add(i);
      merged.set(owner, [...(merged.get(owner) ?? []), f.rule_id ?? ""]);
    }
  });
  const out: Finding[] = [];
  fs.forEach((f, i) => {
    if (dropped.has(i)) {
      return;
    }
    const rules = merged.get(i) ?? [];
    if (rules.length > 0) {
      out.push({
        ...f,
        message:
          f.message +
          " The njsscan rule " +
          rules.join(", ") +
          " matched the same code and is merged into this Finding.",
      });
    } else {
      out.push(f);
    }
  });
  return out;
}

// The Go types of the two reports, for json.Unmarshal and its error texts.
const str: Schema = { kind: "string" };
const ints: Schema = { kind: "slice", type: "[]int", elem: { kind: "int" } };
const scanErrors: Schema = {
  kind: "slice",
  type: "[]checks.scanError",
  elem: {
    kind: "struct",
    type: "checks.scanError",
    fields: [
      { name: "path", schema: str },
      { name: "message", schema: str },
    ],
  },
};
const njsFileType =
  'struct { FilePath string "json:\\"file_path\\""; MatchLines []int "json:\\"match_lines\\""; MatchPosition []int "json:\\"match_position\\""; MatchString string "json:\\"match_string\\"" }';
const njsMetadataType =
  'struct { CWE string "json:\\"cwe\\""; Description string "json:\\"description\\"" }';
const njsscanRuleSchema: Schema = {
  kind: "struct",
  type: "checks.njsscanRule",
  fields: [
    {
      name: "files",
      schema: {
        kind: "slice",
        type: `[]${njsFileType}`,
        elem: {
          kind: "struct",
          type: njsFileType,
          fields: [
            { name: "file_path", schema: str },
            { name: "match_lines", schema: ints },
            { name: "match_position", schema: ints },
            { name: "match_string", schema: str },
          ],
        },
      },
    },
    {
      name: "metadata",
      schema: {
        kind: "struct",
        type: njsMetadataType,
        fields: [
          { name: "cwe", schema: str },
          { name: "description", schema: str },
        ],
      },
    },
  ],
};
const njsRules: Schema = {
  kind: "map",
  type: "map[string]checks.njsscanRule",
  elem: njsscanRuleSchema,
};
const njsscanDocSchema: Schema = {
  kind: "struct",
  type: "checks.njsscanDoc",
  fields: [
    { name: "errors", schema: scanErrors },
    { name: "nodejs", schema: njsRules },
    { name: "templates", schema: njsRules },
  ],
};

const positionType = "struct { Line int; Col int }";
const position: Schema = {
  kind: "struct",
  type: positionType,
  fields: [
    { name: "Line", schema: { kind: "int" } },
    { name: "Col", schema: { kind: "int" } },
  ],
};
const extraType = 'struct { Message string "json:\\"message\\"" }';
const semgrepResultType = `struct { CheckID string "json:\\"check_id\\""; Path string "json:\\"path\\""; Start ${positionType}; End ${positionType}; Extra ${extraType} "json:\\"extra\\"" }`;
const semgrepDocSchema: Schema = {
  kind: "struct",
  type: "checks.semgrepDoc",
  fields: [
    {
      name: "results",
      schema: {
        kind: "slice",
        type: `[]${semgrepResultType}`,
        elem: {
          kind: "struct",
          type: semgrepResultType,
          fields: [
            { name: "check_id", schema: str },
            { name: "path", schema: str },
            { name: "Start", schema: position },
            { name: "End", schema: position },
            {
              name: "extra",
              schema: {
                kind: "struct",
                type: extraType,
                fields: [{ name: "message", schema: str }],
              },
            },
          ],
        },
      },
    },
    { name: "errors", schema: scanErrors },
  ],
};

type Raw = Record<string, unknown>;

function items(v: unknown): unknown[] {
  return v instanceof GoSlice ? v.items() : [];
}

function numbers(v: unknown): number[] {
  return items(v).map((x) => Number(x as bigint));
}

function errorsOf(v: unknown): ScanError[] {
  return items(v).map((e) => {
    const r = e as Raw;
    return { path: r.path as string, message: r.message as string };
  });
}

function decode(out: Uint8Array, schema: Schema, root: string): Raw {
  try {
    return unmarshal(out, schema) as Raw;
  } catch (err) {
    throw new Error(unmarshalText(err, root), { cause: err });
  }
}

/**
 * njsscanReport reads njsscan's `--json` output into Findings, and lists the
 * files it could not read. For a file that was scanned as a rewritten copy
 * (rewritten holds project paths), the matched text is the original's. It
 * throws Go's error text for output that is not the report.
 */
export function njsscanReport(
  input: Input,
  out: Uint8Array,
  rewritten: ReadonlySet<string> | null,
): [Finding[], string[]] {
  const r = readNjsscan(input, out, rewritten);
  return [r.findings, mergeSorted(r.paths, r.notes)];
}

export function readNjsscan(
  input: Input,
  out: Uint8Array,
  rewritten: ReadonlySet<string> | null,
): Reading {
  const doc = decode(out, njsscanDocSchema, "njsscanDoc");
  const hits: PatternHit[] = [];
  for (const section of [doc.nodejs, doc.templates]) {
    const rules =
      (section as Map<string, Raw> | null) ?? new Map<string, Raw>();
    for (const id of sortStrings([...rules.keys()])) {
      const r = rules.get(id) ?? {};
      const metadata = r.metadata as Raw;
      const cweText = metadata.cwe as string;
      const colon = cweText.indexOf(":");
      const cwe = colon < 0 ? cweText : cweText.slice(0, colon);
      const description = metadata.description as string;
      for (const fv of items(r.files)) {
        const f = fv as Raw;
        const p = patternsProjectPath(input, f.file_path as string);
        const lines = numbers(f.match_lines);
        if (p === undefined || lines.length === 0) {
          continue;
        }
        const h: PatternHit = {
          rule: "njsscan/" + id,
          path: p,
          line: lines[0] ?? 0,
          col: 0,
          endLine: lines[lines.length - 1] ?? 0,
          endCol: 0,
          description,
          matched: toByteString(f.match_string as string),
          message: `njsscan rule ${id} matched an insecure pattern (${cwe}): ${description}`,
        };
        if (rewritten?.has(p) === true) {
          h.matched = matchedLines(input, p, h.line, h.endLine);
        }
        const position = numbers(f.match_position);
        if (position.length === 2) {
          h.col = position[0] ?? 0;
          h.endCol = position[1] ?? 0;
        }
        hits.push(h);
      }
    }
  }
  const [paths, notes] = unparsedPaths(input, errorsOf(doc.errors));
  return { findings: patternFindings(input, hits, "njsscan"), paths, notes };
}

/**
 * semgrepReport reads semgrep's `--json` output of the tool-owned rules into
 * Findings, and lists the files it could not parse. The output holds no
 * matched text without a login, so the lines come from the Snapshot copy.
 */
export function semgrepReport(
  input: Input,
  out: Uint8Array,
): [Finding[], string[]] {
  const r = readSemgrep(input, out);
  return [r.findings, mergeSorted(r.paths, r.notes)];
}

export function readSemgrep(input: Input, out: Uint8Array): Reading {
  const doc = decode(out, semgrepDocSchema, "semgrepDoc");
  const hits: PatternHit[] = [];
  for (const rv of items(doc.results)) {
    const r = rv as Raw;
    const p = patternsProjectPath(input, r.path as string);
    if (p === undefined) {
      continue;
    }
    // The rule ID is the one in the rules file, behind the folder semgrep
    // derives from the config path.
    const checkID = r.check_id as string;
    const id = checkID.slice(checkID.lastIndexOf(".") + 1);
    const start = r.Start as Raw;
    const end = r.End as Raw;
    const message = (r.extra as Raw).message as string;
    const line = Number(start.Line);
    const endLine = Number(end.Line);
    hits.push({
      rule: "prueffactory/" + id,
      path: p,
      line,
      col: Number(start.Col),
      endLine,
      endCol: Number(end.Col),
      description: message,
      matched: matchedLines(input, p, line, endLine),
      message: `The js-prueffactory rule ${id} matched an insecure pattern: ${message}`,
    });
  }
  const [paths, notes] = unparsedPaths(input, errorsOf(doc.errors));
  return { findings: patternFindings(input, hits, "semgrep"), paths, notes };
}

/**
 * matchedLines returns the text of the lines of a project file, cut to a
 * size that suits Evidence, or "" when the file cannot be read. The text is
 * a byte string.
 */
export function matchedLines(
  input: Input,
  rel: string,
  from: number,
  to: number,
): string {
  let data: Uint8Array;
  try {
    data = readProjectFile(input, rel);
  } catch {
    return "";
  }
  if (from < 1 || to < from) {
    return "";
  }
  const lines = latin1(data).split("\n");
  if (from > lines.length) {
    return "";
  }
  to = Math.min(to, lines.length, from + 9);
  const text = trimEndNewlines(lines.slice(from - 1, to).join("\n"));
  return shortenBytes(text, 400);
}

// trimEndNewlines is strings.TrimRight(s, "\r\n"), in a single pass.
function trimEndNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  return s.slice(0, end);
}

// shortenBytes is shorten over a byte string: cut back to the start of a
// UTF-8 sequence, as Go's cutBytes does.
function shortenBytes(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  let cut = n;
  while (cut > 0 && (s.charCodeAt(cut) & 0xc0) === 0x80) {
    cut--;
  }
  return s.slice(0, cut) + "...";
}
