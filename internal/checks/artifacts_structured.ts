// artifacts.structured parses every .json, .yaml and .yml file of the project
// on the host-side Snapshot copy (Go: artifacts_structured.go). It is native
// and starts no container. A file that does not parse is a Gate, or a note in
// Test data. Build output and the templates/ folders of Helm charts are
// skipped and listed.
import type { File, Project } from "../discovery/discovery.ts";
import { BuildOutput, TestData } from "../discovery/discovery.ts";
import { stripJSONC } from "../discovery/jsonc.ts";
import { base, dir, ext, match } from "../gocompat/path.ts";
import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { checkValid } from "../gocompat/unmarshal.ts";
import { decodeRune } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Limitation,
  NotApplicable,
  SeverityError,
  SeverityNote,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import * as yaml from "../yamlv3/yaml.ts";
import { type Check, register } from "./check.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  errNotRegular,
  errTooLarge,
  readProjectFile,
  tooLargeLimitation,
} from "./readcap.ts";
import { buildOutputRoot } from "./syntax_parse.ts";

export const structuredID = "artifacts.structured";
export const ruleInvalidJSON = "invalid-json";
export const ruleInvalidYAML = "invalid-yaml";
const reasonHelmTemplate = "helm_templates_skipped";

export const artifactsStructured: Check = {
  applicability(p, c) {
    if (c.package !== null) {
      return [
        NotApplicable,
        "artifacts.structured examines the whole project, and this is a package Context",
      ];
    }
    const [checked] = structuredTargets(p);
    if (checked.length === 0) {
      return [
        NotApplicable,
        "the project has no JSON or YAML files outside Build output and Helm templates",
      ];
    }
    return [Applicable, ""];
  },

  run(_signal, input) {
    return Promise.resolve(runStructured(input));
  },
};

register(structuredID, artifactsStructured);

function runStructured(input: Input): Result {
  const [checked, build, helm] = structuredTargets(input.project);
  const findings: Finding[] = [];
  const limitations = structuredLimitations(build, helm);
  const res: Result = { status: StatusCompleted, findings, limitations };

  const unreadable: string[] = [];
  const tooLarge: string[] = [];
  for (const f of checked) {
    let data: Uint8Array;
    try {
      data = readProjectFile(input, f.path);
    } catch (err) {
      if (err === errNotRegular) {
        continue;
      }
      if (err === errTooLarge) {
        tooLarge.push(f.path);
        continue;
      }
      unreadable.push(
        f.path + ": " + (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }
    const perr = parseStructured(f.path, data);
    if (perr !== null) {
      findings.push(structuredFinding(input, f, perr));
    }
  }
  // Array.prototype.sort is stable, as Go's sort.SliceStable.
  findings.sort((a, b) =>
    compareBytes(a.locations[0]?.path ?? "", b.locations[0]?.path ?? ""),
  );

  limitations.push(...tooLargeLimitation(structuredID, tooLarge));
  if (unreadable.length > 0) {
    res.status = StatusPartial;
    res.reasonCode = "check_could_not_run_on_some_files";
    res.reason = `${String(unreadable.length)} of ${String(checked.length)} files could not be read, for example ${unreadable[0] ?? ""}`;
  }
  return res;
}

/**
 * ParseError is where and why a file does not parse. A zero line or column
 * means the parser does not say.
 */
export interface ParseError {
  rule: string;
  line: number;
  column: number;
  message: string;
}

const kindWord: Readonly<Record<string, string>> = {
  [ruleInvalidJSON]: "JSON",
  [ruleInvalidYAML]: "YAML",
};

function structuredFinding(input: Input, f: File, perr: ParseError): Finding {
  const inTestData = f.class === TestData;
  const word = kindWord[perr.rule] ?? "";
  const finding = newFinding({
    check_id: structuredID,
    context_id: input.context.id,
    rule_id: perr.rule,
    fingerprint: newFingerprint(structuredID, perr.rule, f.path, perr.message),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    in_test_data: inTestData,
    title:
      perr.rule === ruleInvalidYAML
        ? "YAML file does not parse"
        : "JSON file does not parse",
    message: `The file is not valid ${word}, so a tool that reads it will fail.`,
    locations: [input.location("primary", f.path, perr.line, perr.column)],
    evidence: [
      untrusted("tool_output", perr.message, "artifacts.structured parser"),
    ],
    reproduction: input.reproduction(structuredID),
    limitations: [],
  });
  if (inTestData) {
    finding.severity = SeverityNote;
    finding.gate = false;
    finding.message = `The file is not valid ${word}. Test data may be invalid on purpose, so this is only a note.`;
  }
  return finding;
}

function structuredLimitations(
  build: readonly File[],
  helm: ReadonlyMap<string, number>,
): Limitation[] {
  const out: Limitation[] = [];
  const counts = new Map<string, number>();
  for (const f of build) {
    const r = buildOutputRoot(f.path);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  for (const r of sortStrings([...counts.keys()])) {
    out.push({
      reason_code: "build_output_skipped",
      message: `${String(counts.get(r))} JSON or YAML file(s) not examined because they are Build output`,
      check_id: structuredID,
      path: r,
    });
  }
  for (const d of sortStrings([...helm.keys()])) {
    out.push({
      reason_code: reasonHelmTemplate,
      message: `${String(helm.get(d))} file(s) in a Helm chart's templates folder not examined, because repository.helm covers them`,
      check_id: structuredID,
      path: d,
    });
  }
  return out;
}

/** StructuredKind is how a file is parsed. */
export type StructuredKind = "none" | "json" | "yaml";

export function structuredKindOf(rel: string): StructuredKind {
  switch (ext(rel)) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
  }
  return "none";
}

/**
 * structuredTargets splits the project's files into the ones to parse, the
 * Build output files that are skipped, and the files below Helm templates/
 * folders that are skipped, counted per folder.
 */
export function structuredTargets(
  p: Project,
): [checked: File[], build: File[], helm: Map<string, number>] {
  const checked: File[] = [];
  const build: File[] = [];
  const helm = new Map<string, number>();
  const templates = helmTemplateFolders(p.files);
  for (const f of p.files) {
    if (structuredKindOf(f.path) === "none") {
      continue;
    }
    const folder = containingFolder(templates, f.path);
    if (folder !== "") {
      helm.set(folder, (helm.get(folder) ?? 0) + 1);
      continue;
    }
    if (f.class === BuildOutput) {
      build.push(f);
      continue;
    }
    checked.push(f);
  }
  return [checked, build, helm];
}

/**
 * helmTemplateFolders returns the templates/ folder of every folder that
 * holds a Chart.yaml, as project-relative paths.
 */
function helmTemplateFolders(files: readonly File[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (base(f.path) !== "Chart.yaml") {
      continue;
    }
    const d = dir(f.path);
    out.push(d === "." ? "templates" : d + "/templates");
  }
  return out;
}

/** containingFolder returns the folder of the list that holds file, or "". */
function containingFolder(folders: readonly string[], file: string): string {
  for (const d of folders) {
    if (
      file.length > d.length &&
      file.startsWith(d) &&
      file[d.length] === "/"
    ) {
      return d;
    }
  }
  return "";
}

/** parseStructured parses one file, returning null when it is valid. */
export function parseStructured(
  rel: string,
  data: Uint8Array,
): ParseError | null {
  if (structuredKindOf(rel) === "yaml") {
    return parseYAML(data);
  }
  return parseJSON(data, jsoncLeniencyOf(rel));
}

/**
 * yamlLine is Go's `line (\d+):\s*` with RE2's \d and \s. It runs in linear
 * time: a match can only start at the literal "line ", and the digits and
 * the white space after it are each scanned once per start.
 */
const yamlLine = /line ([0-9]+):[\t\n\f\r ]*/;
const yamlLineAll = /line [0-9]+:[\t\n\f\r ]*/g;

/**
 * parseYAML reads every document of the file into yaml.Node values, which
 * accepts any tag, including unknown ones such as !reference. The parser
 * names the line of an error but not the column.
 */
function parseYAML(data: Uint8Array): ParseError | null {
  const dec = new yaml.Decoder(data);
  for (;;) {
    let doc: yaml.Node | null;
    try {
      doc = dec.decode();
    } catch (err) {
      if (!(err instanceof yaml.YAMLError)) {
        // Go recovers a panic of the parser.
        return {
          rule: ruleInvalidYAML,
          line: 0,
          column: 0,
          message:
            "the YAML parser failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
      return yamlParseError(data, err.message);
    }
    if (doc === null) {
      return null;
    }
  }
}

export function yamlParseError(data: Uint8Array, text: string): ParseError {
  let msg = text.startsWith("yaml: ") ? text.slice("yaml: ".length) : text;
  let line = 0;
  let column = 0;
  const m = yamlLine.exec(msg);
  if (m !== null) {
    line = atoi(m[1] ?? "0");
    msg = msg.replace(yamlLineAll, "");
  } else if (msg.includes("control characters are not allowed")) {
    // The reader of the parser does not say where. A UTF-8 text that was
    // once read as Windows-1252 leaves U+009D and the like in it.
    const [off, r] = firstDisallowedYAMLChar(data);
    if (off >= 0) {
      [line, column] = lineAndColumn(data, off);
      msg = `${msg} (U+${r.toString(16).toUpperCase().padStart(4, "0")})`;
    }
  }
  return { rule: ruleInvalidYAML, line, column, message: msg };
}

/** atoi is strconv.Atoi of a run of ASCII digits, clamped as Go clamps it. */
function atoi(digits: string): number {
  const n = BigInt(digits);
  const max = 2n ** 63n - 1n;
  return Number(n > max ? max : n);
}

/**
 * firstDisallowedYAMLChar returns the byte offset and the code point of the
 * first character that YAML does not allow in a stream: a control character
 * other than tab, line feed, carriage return and NEL, and U+FFFE and U+FFFF.
 * The offset is -1 when there is none. Invalid UTF-8 counts as U+FFFD.
 */
function firstDisallowedYAMLChar(data: Uint8Array): [number, number] {
  for (let i = 0; i < data.length;) {
    const [r, size] = decodeRune(data, i);
    const allowed = r === 0x09 || r === 0x0a || r === 0x0d || r === 0x85;
    if (
      !allowed &&
      (r < 0x20 || (r >= 0x7f && r < 0xa0) || r === 0xfffe || r === 0xffff)
    ) {
      return [i, r];
    }
    i += size;
  }
  return [-1, 0];
}

function hasBOM(data: Uint8Array): boolean {
  return (
    data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
  );
}

/**
 * parseJSON checks a document with encoding/json and turns its byte offset
 * into a line and a column counted in characters.
 */
function parseJSON(
  data: Uint8Array,
  lenient: JSONCLeniency,
): ParseError | null {
  if (hasBOM(data)) {
    data = data.subarray(3);
  }
  const toParse =
    lenient === "strict"
      ? data
      : stripJSONC(data, lenient === "commentsAndTrailingCommas");
  const err = checkValid(toParse);
  if (err === undefined) {
    return null;
  }
  let offset = data.length;
  if (
    err.offset > 0 &&
    err.offset <= data.length &&
    err.message !== "unexpected end of JSON input"
  ) {
    // Offset counts the bytes read, including the offending one.
    offset = err.offset - 1;
  }
  const [line, column] = lineAndColumn(data, offset);
  return { rule: ruleInvalidJSON, line, column, message: err.message };
}

/**
 * lineAndColumn returns the 1-based line and character column of a byte
 * offset. Each byte of invalid UTF-8 counts as one character, as in Go's
 * utf8.RuneCount.
 */
export function lineAndColumn(
  data: Uint8Array,
  offset: number,
): [line: number, column: number] {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < data.length; i++) {
    if (data[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  const head = data.subarray(0, Math.min(offset, data.length));
  let runes = 0;
  for (let i = lineStart; i < head.length; runes++) {
    i += decodeRune(head, i)[1];
  }
  return [line, runes + 1];
}

/**
 * JSONCLeniency says what a JSON file may contain beyond strict JSON:
 * "commentsOnly" for files whose tools accept comments but not trailing
 * commas, "commentsAndTrailingCommas" for files read as JSONC by TypeScript
 * or VS Code.
 */
type JSONCLeniency = "strict" | "commentsOnly" | "commentsAndTrailingCommas";

/**
 * jsoncLeniencyOf returns what the file may contain, by its name. Files not
 * named here must be strict JSON.
 */
function jsoncLeniencyOf(rel: string): JSONCLeniency {
  const b = base(rel);
  if (b === ".eslintrc.json" || b === "biome.json") {
    return "commentsOnly";
  }
  if (
    b === "biome.jsonc" ||
    b === "devcontainer.json" ||
    match("tsconfig*.json", b) === true ||
    match("jsconfig*.json", b) === true ||
    base(dir(rel)) === ".vscode"
  ) {
    return "commentsAndTrailingCommas";
  }
  return "strict";
}
