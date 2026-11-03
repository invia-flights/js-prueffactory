// This file turns the output of the project's own linters into Findings (Go:
// lint_existing_parse.go). An error-level diagnostic is an error and a warning
// is a warning; repoFinding applies that rule to the level it is given. Under
// execution-v2 an error is a Gate only in Source code: the project's own
// rules for its tests, fixtures and generated files do not say that the
// service is broken.
import { classify, type FileClass, Source } from "../discovery/discovery.ts";
import { errorMessage } from "../gocompat/errors.ts";
import { quoteJSONString } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { fields as fieldsOf, trimSpace } from "../gocompat/strings.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { decodeRune } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  SeverityError,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { tail } from "./cut_text.ts";
import { type Input, untrusted } from "./input.ts";
import { workPath } from "./package_install.ts";
import { cutTitle, repoFinding } from "./repo_findings.ts";
import { UnreadableOutput } from "./tool_output.ts";

/** lintExistingID is defined here so that the parts of the Check need no cycle. */
export const lintExistingID = "lint.existing";

const str: Schema = { kind: "string" };
const int: Schema = { kind: "int" };
const bool: Schema = { kind: "bool" };

function struct(type: string, fields: [string, Schema][]): Schema {
  return {
    kind: "struct",
    type,
    fields: fields.map(([name, schema]) => ({ name, schema })),
  };
}

// --- ESLint ---

const eslintMessageType =
  'struct { RuleID *string "json:\\"ruleId\\""; Severity int "json:\\"severity\\""; Message string "json:\\"message\\""; Line int "json:\\"line\\""; Column int "json:\\"column\\""; Fatal bool "json:\\"fatal\\"" }';
const eslintFileType = `struct { FilePath string "json:\\"filePath\\""; Messages []${eslintMessageType} "json:\\"messages\\"" }`;

const eslintSchema: Schema = {
  kind: "slice",
  type: "[]" + eslintFileType,
  elem: struct(eslintFileType, [
    ["filePath", str],
    [
      "messages",
      {
        kind: "slice",
        type: "[]" + eslintMessageType,
        elem: struct(eslintMessageType, [
          ["ruleId", { kind: "pointer", elem: str }],
          ["severity", int],
          ["message", str],
          ["line", int],
          ["column", int],
          ["fatal", bool],
        ]),
      },
    ],
  ]),
};

interface ESLintJSONMessage {
  ruleId: string | null;
  severity: bigint;
  message: string;
  line: bigint;
  column: bigint;
  fatal: boolean;
}

/**
 * projectESLintFindings reads the stdout of `eslint --format json`, a list of
 * files with their messages. Messages the project's own directives suppressed
 * are listed apart by ESLint and are no findings. Files outside the package,
 * such as a config the project extends from a parent folder, cannot be placed
 * in the project and are left out. It throws for output that is no such list.
 */
export function projectESLintFindings(
  input: Input,
  stdout: Uint8Array,
): Finding[] {
  let files: { filePath: string; messages: GoSlice | null }[];
  try {
    files = ((unmarshal(stdout, eslintSchema) as GoSlice | null)?.items() ??
      []) as typeof files;
  } catch (err) {
    throw new UnreadableOutput(
      `ESLint printed no JSON report: ${errorMessage(err)}`,
      "it is not the JSON list of files that ESLint documents",
      { cause: err },
    );
  }
  const pkg = input.pkg();
  const prefix = workPath(pkg) + "/";
  const isSource = sourceFiles(input);
  const out: Finding[] = [];
  for (const f of files) {
    if (!f.filePath.startsWith(prefix)) {
      continue;
    }
    const rel = f.filePath.slice(prefix.length);
    for (const m of (f.messages?.items() ?? []) as ESLintJSONMessage[]) {
      let rule = "eslint-directive";
      if (m.ruleId !== null && m.ruleId !== "") {
        rule = m.ruleId;
      } else if (m.fatal) {
        rule = "parse-error";
      }
      const level = m.severity >= 2n ? "error" : "warning";
      const path = projectFile(input, rel);
      out.push(
        repoFinding(input, lintExistingID, {
          tool: "eslint",
          rule,
          level,
          path,
          line: Number(m.line),
          column: Number(m.column),
          message: m.message,
          // Go's json.Marshal of a map: the keys come out sorted.
          raw:
            `{"column":${m.column.toString()},"file":${quoteJSONString(rel, true)},` +
            `"line":${m.line.toString()},"message":${quoteJSONString(m.message, true)},` +
            `"rule":${quoteJSONString(rule, true)},"severity":${m.severity.toString()}}`,
          gate: isSource(path),
        }),
      );
    }
  }
  return out;
}

// --- Biome ---
//
// The JSON reporter of Biome 2.x is documented as experimental ("may change in
// patch releases"), and its shape has changed once between the 2.x versions
// that exist. A diagnostic is read in both:
//
//   2.0 to 2.3 (run for 2.0.0, 2.1.2, 2.2.7, 2.3.0, 2.3.5, 2.3.10 and 2.3.15)
//     {"category":"lint/suspicious/noDebugger","severity":"error",
//      "description":"...","message":[...elements],"advices":{...},
//      "location":{"path":{"file":"src/index.js"},"span":[20,29],
//                  "sourceCode":"...the whole file..."}}
//     the position is a byte span in sourceCode
//   2.4 and later (run for 2.4.0, 2.4.16, 2.5.0, 2.5.1, 2.5.15 and 2.6.4)
//     {"severity":"error","message":"...","category":"lint/suspicious/noDebugger",
//      "location":{"path":"src/index.js","start":{"line":2,"column":3},
//                  "end":{"line":2,"column":12}},"advices":[...]}
//     line and column count from 1, columns count characters
//
// Output that fits neither is not read: it says nothing about the project.

const biomeUnreadableSummary =
  "its JSON report does not have the shape Biome documents";

/** BiomeDiagnostic is what is read of one diagnostic of Biome's JSON reporter. */
interface BiomeDiagnostic {
  category: string;
  severity: string;
  description: string;
  /** file is the path Biome printed, relative to its working folder, or "". */
  file: string;
  line: number;
  column: number;
  /** place is the part of the Evidence that says where Biome found it. */
  place: { before: string; after: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function biomeShapeError(what: string): UnreadableOutput {
  return new UnreadableOutput(
    `Biome printed JSON of another shape than it documents: ${what}`,
    biomeUnreadableSummary,
  );
}

/**
 * readBiomeDiagnostics decodes the stdout of `biome lint --reporter=json`. It
 * throws UnreadableOutput when it is not a JSON document with a list of
 * diagnostics in one of the two shapes above.
 */
function readBiomeDiagnostics(stdout: Uint8Array): BiomeDiagnostic[] {
  const text = Buffer.from(stdout).toString("utf8");
  if (trimSpace(text) === "") {
    throw new UnreadableOutput(
      "Biome printed no JSON report: it printed nothing",
      "it printed no report",
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new UnreadableOutput(
      `Biome printed no JSON report: ${errorMessage(err)}`,
      "it is not valid JSON",
      { cause: err },
    );
  }
  const list = isRecord(doc) ? doc.diagnostics : undefined;
  if (!Array.isArray(list)) {
    throw biomeShapeError("there is no list of diagnostics");
  }
  return (list as unknown[]).map(readBiomeDiagnostic);
}

function readBiomeDiagnostic(d: unknown, i: number): BiomeDiagnostic {
  const at = `diagnostics[${String(i)}]`;
  if (!isRecord(d)) {
    throw biomeShapeError(`${at} is not an object`);
  }
  const { category, severity, description, message } = d;
  if (category != null && typeof category !== "string") {
    throw biomeShapeError(`${at}.category is not a string`);
  }
  if (typeof severity !== "string") {
    throw biomeShapeError(`${at}.severity is not a string`);
  }
  if (description != null && typeof description !== "string") {
    throw biomeShapeError(`${at}.description is not a string`);
  }
  const out: BiomeDiagnostic = {
    category: category ?? "",
    severity,
    // 2.1 writes the text as `description` (its `message` is a list of
    // elements), 2.4 and later as the string `message`.
    description: description ?? (typeof message === "string" ? message : ""),
    file: "",
    line: 0,
    column: 0,
    place: { before: "", after: "" },
  };
  const location = d.location;
  if (location == null) {
    return out;
  }
  if (!isRecord(location)) {
    throw biomeShapeError(`${at}.location is not an object`);
  }
  const path = location.path;
  if (typeof path === "string") {
    readNewBiomeLocation(out, location, path, `${at}.location`);
  } else if (isRecord(path)) {
    readOldBiomeLocation(out, location, path, `${at}.location`);
  } else {
    throw biomeShapeError(
      `${at}.location.path is neither a string nor an object`,
    );
  }
  return out;
}

/** position reads {"line":2,"column":3}; both count from 1. */
function readBiomePosition(v: unknown, at: string): [number, number] {
  if (
    !isRecord(v) ||
    !Number.isInteger(v.line) ||
    !Number.isInteger(v.column)
  ) {
    throw biomeShapeError(`${at} is not a line and a column`);
  }
  return [v.line as number, v.column as number];
}

/** readNewBiomeLocation reads the location of Biome 2.4 and later. */
function readNewBiomeLocation(
  out: BiomeDiagnostic,
  location: Record<string, unknown>,
  path: string,
  at: string,
): void {
  out.file = path;
  const start = location.start;
  if (start == null) {
    return;
  }
  [out.line, out.column] = readBiomePosition(start, `${at}.start`);
  // Go's json.Marshal of a map: the keys come out sorted, so the end of the
  // diagnostic goes before the file and the start after the severity.
  let before = "";
  const end = location.end;
  if (
    isRecord(end) &&
    Number.isInteger(end.line) &&
    Number.isInteger(end.column)
  ) {
    before = `"end":{"column":${String(end.column)},"line":${String(end.line)}},`;
  }
  out.place = {
    before,
    after: `,"start":{"column":${String(out.column)},"line":${String(out.line)}}`,
  };
}

/** readOldBiomeLocation reads the location of Biome 2.0 to 2.3. */
function readOldBiomeLocation(
  out: BiomeDiagnostic,
  location: Record<string, unknown>,
  path: Record<string, unknown>,
  at: string,
): void {
  const file = path.file;
  if (file != null && typeof file !== "string") {
    throw biomeShapeError(`${at}.path.file is not a string`);
  }
  out.file = file ?? "";
  const span = location.span;
  if (span == null || out.file === "") {
    return;
  }
  if (!Array.isArray(span) || !(span as unknown[]).every(Number.isInteger)) {
    throw biomeShapeError(`${at}.span is not a list of integers`);
  }
  const offsets = span as number[];
  const sourceCode = location.sourceCode;
  if (sourceCode != null && typeof sourceCode !== "string") {
    throw biomeShapeError(`${at}.sourceCode is not a string`);
  }
  const [from] = offsets;
  if (offsets.length === 2 && from !== undefined) {
    [out.line, out.column] = biomeLineAndColumn(sourceCode ?? "", from);
    out.place = { before: "", after: `,"span":[${offsets.join(",")}]` };
  }
}

/**
 * isBiomeConfigCategory says whether a diagnostic category is one of Biome's
 * own for a configuration that it cannot use: `configuration` and
 * `configuration/...` for the configuration as a whole, `deserialize` for a
 * key or a value in a configuration file that Biome does not accept.
 */
function isBiomeConfigCategory(category: string): boolean {
  return (
    category === "configuration" ||
    category.startsWith("configuration/") ||
    category === "deserialize"
  );
}

/**
 * biomeFindings reads the stdout of `biome lint --reporter=json`, in either
 * shape. A diagnostic of error level in one of Biome's own configuration
 * categories is the project's configuration error; every other diagnostic is
 * a Finding of its rule. Output that is no such report throws
 * UnreadableOutput: it says nothing about the code, and the caller records it
 * as unreadable instead of making a Finding of it.
 */
export function biomeFindings(input: Input, stdout: Uint8Array): Finding[] {
  const diagnostics = readBiomeDiagnostics(stdout);
  const isSource = sourceFiles(input);
  const out: Finding[] = [];
  for (const d of diagnostics) {
    const file =
      d.file === "" ? "" : `"file":${quoteJSONString(d.file, true)},`;
    // Go's json.Marshal of a map: the keys come out sorted.
    const raw =
      `{"category":${quoteJSONString(d.category, true)},` +
      `"description":${quoteJSONString(d.description, true)},${d.place.before}${file}` +
      `"severity":${quoteJSONString(d.severity, true)}${d.place.after}}`;
    const level = biomeLevel(d.severity);
    if (level === "error" && isBiomeConfigCategory(d.category)) {
      out.push(
        lintProjectError(
          input,
          "biome",
          "biome-config-error",
          "Biome failed with the project's configuration",
          `Biome reports an error in its configuration: ${cutTitle(d.description)}`,
          raw,
          d.file === "" ? biomeConfigFile(input) : d.file,
        ),
      );
      continue;
    }
    const path = projectFile(input, d.file === "" ? "package.json" : d.file);
    out.push(
      repoFinding(input, lintExistingID, {
        tool: "biome",
        rule: d.category === "" ? "biome-diagnostic" : d.category,
        level,
        message: d.description,
        path,
        line: d.line,
        column: d.column,
        raw,
        gate: isSource(path),
      }),
    );
  }
  return out;
}

/**
 * biomeConfigDiagnostic says whether what Biome printed on stderr holds a
 * diagnostic of its own that says the configuration is wrong. Biome writes
 * each diagnostic as a header line (a location, the category and some tags,
 * then a run of box-drawing characters) followed by its text, where an error
 * starts with "×", a warning with "!" and a note with "i". Only an error in a
 * configuration category counts: the deprecation notice that Biome 2.6 prints
 * about a configuration it can use is a note, and a text that names no
 * category says nothing about the configuration.
 */
export function biomeConfigDiagnostic(stderr: string): boolean {
  let inConfigDiagnostic = false;
  for (const raw of stderr.split("\n")) {
    const header = diagnosticHeaderWords(raw);
    if (header !== null) {
      inConfigDiagnostic = header.some(isBiomeConfigCategory);
    } else if (inConfigDiagnostic && trimSpace(raw).startsWith("×")) {
      return true;
    }
  }
  return false;
}

/**
 * diagnosticHeaderWords is the words before the rule of a diagnostic header
 * line of Biome's text output, or null for any other line. A header starts in
 * the first column and ends in a run of "━".
 */
function diagnosticHeaderWords(line: string): string[] | null {
  const text = trimSpace(line);
  if (text === "" || line.startsWith(" ") || !text.endsWith("━━━")) {
    return null;
  }
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "━") {
    end--;
  }
  return fieldsOf(text.slice(0, end));
}

/**
 * sourceFiles returns the test of the Gate rule of lint.existing: an error of
 * the project's own linter is a Gate when the File class of its file is
 * Source code. The class is the one the Input's project holds, which includes
 * the files the test runners load (the Check waits for the test file probe);
 * a path in no file list is classified by its folder names, as the engine
 * does when it sets in_test_code.
 */
function sourceFiles(input: Input): (path: string) => boolean {
  const classes = new Map<string, FileClass>();
  for (const f of input.project.files) {
    classes.set(f.path, f.class);
  }
  return (path) => (classes.get(path) ?? classify(path)) === Source;
}

/** biomeLevel maps Biome's severities onto the levels repoFinding knows. */
export function biomeLevel(severity: string): string {
  switch (severity) {
    case "fatal":
    case "error":
      return "error";
    case "warning":
      return "warning";
  }
  return "info";
}

/**
 * biomeLineAndColumn turns a byte offset into a 1-based line and a 1-based
 * column counted in characters. An offset outside the text gives no position.
 * The offset counts UTF-8 bytes of the source, so the text is sliced as bytes.
 */
export function biomeLineAndColumn(
  src: string,
  offset: bigint | number,
): [line: number, column: number] {
  const bytes = Buffer.from(src, "utf8");
  if (offset < 0 || offset > bytes.length) {
    return [0, 0];
  }
  const before = bytes.subarray(0, Number(offset));
  let line = 1;
  for (const b of before) {
    if (b === 0x0a) {
      line++;
    }
  }
  const lineStart = before.lastIndexOf(0x0a) + 1;
  let column = 1;
  for (let i = lineStart; i < before.length;) {
    i += decodeRune(before, i)[1];
    column++;
  }
  return [line, column];
}

/**
 * projectFile is a path relative to the folder of the package as a path
 * relative to the project root. The paths come from a linter that ran project
 * code, so the result is confined to the project root, whatever they hold.
 */
export function projectFile(input: Input, rel: string): string {
  const p = join("/", input.pkg().path, rel);
  return p.startsWith("/") ? p.slice(1) : p;
}

/**
 * lintProjectError is the Gate Finding of a linter that cannot lint because
 * of something in the project's files: Biome or ESLint says so in its own
 * words, or the linter that the package lists is not installed. file is
 * relative to the package folder.
 */
export function lintProjectError(
  input: Input,
  tool: string,
  rule: string,
  title: string,
  message: string,
  evidence: string,
  file: string,
): Finding {
  const rel = projectFile(input, file);
  const detail = cutTitle(evidence);
  return newFinding({
    check_id: lintExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(lintExistingID, rule, rel, detail),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title,
    message,
    locations: [input.location("primary", rel, 0, 0)],
    evidence: [untrusted("tool_output", tail(evidence, 4000), tool)],
    reproduction: input.reproduction(lintExistingID),
    limitations: [],
  });
}

/**
 * biomeConfigFile is the package-relative path of Biome's configuration, or
 * package.json when the package has none.
 */
export function biomeConfigFile(input: Input): string {
  for (const f of input.pkg().files) {
    if (f.packageRel === "biome.json" || f.packageRel === "biome.jsonc") {
      return f.packageRel;
    }
  }
  return "package.json";
}
