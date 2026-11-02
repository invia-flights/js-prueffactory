// This file turns the output of the project's own linters into Findings (Go:
// lint_existing_parse.go). An error-level diagnostic is a Gate and a warning
// is a warning. repoFinding applies that rule to the level it is given.
import { quoteJSONString } from "../gocompat/json.ts";
import { join } from "../gocompat/path.ts";
import { decodeRune } from "../gocompat/utf8.ts";
import { type GoSlice, type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import type { Finding } from "../resultset/types.ts";
import type { Input } from "./input.ts";
import { workPath } from "./package_install.ts";
import { repoFinding } from "./repo_findings.ts";

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
    throw new Error(
      `ESLint printed no JSON report: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const pkg = packageOf(input);
  const prefix = workPath(pkg) + "/";
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
      out.push(
        repoFinding(input, lintExistingID, {
          tool: "eslint",
          rule,
          level,
          path: projectFile(input, rel),
          line: Number(m.line),
          column: Number(m.column),
          message: m.message,
          // Go's json.Marshal of a map: the keys come out sorted.
          raw:
            `{"column":${m.column.toString()},"file":${quoteJSONString(rel, true)},` +
            `"line":${m.line.toString()},"message":${quoteJSONString(m.message, true)},` +
            `"rule":${quoteJSONString(rule, true)},"severity":${m.severity.toString()}}`,
        }),
      );
    }
  }
  return out;
}

// --- Biome ---

const biomeLocationType =
  'struct { Path struct { File string "json:\\"file\\"" } "json:\\"path\\""; Span []int "json:\\"span\\""; SourceCode string "json:\\"sourceCode\\"" }';
const biomeDiagnosticType = `checks.biomeDiagnostic`;

// biomeDiagnostic is what is read of one diagnostic of Biome's JSON reporter.
// The reporter also prints advices and the whole source of each file for every
// diagnostic; none of that is kept.
const biomeSchema: Schema = struct(
  'struct { Diagnostics []checks.biomeDiagnostic "json:\\"diagnostics\\"" }',
  [
    [
      "diagnostics",
      {
        kind: "slice",
        type: "[]" + biomeDiagnosticType,
        elem: struct(biomeDiagnosticType, [
          ["category", str],
          ["severity", str],
          ["description", str],
          [
            "location",
            {
              kind: "pointer",
              elem: struct(biomeLocationType, [
                ["path", struct("struct { File string }", [["file", str]])],
                ["span", { kind: "slice", type: "[]int", elem: int }],
                ["sourceCode", str],
              ]),
            },
          ],
        ]),
      },
    ],
  ],
);

interface BiomeDiagnostic {
  category: string;
  severity: string;
  description: string;
  location: {
    path: { file: string };
    span: GoSlice | null;
    sourceCode: string;
  } | null;
}

/**
 * biomeFindings reads the stdout of `biome lint --reporter=json`. Output that
 * is not Biome's JSON is an error (it throws): it says nothing about the code.
 */
export function biomeFindings(input: Input, stdout: Uint8Array): Finding[] {
  let diagnostics: BiomeDiagnostic[];
  try {
    const doc = unmarshal(stdout, biomeSchema) as {
      diagnostics: GoSlice | null;
    };
    diagnostics = (doc.diagnostics?.items() ?? []) as BiomeDiagnostic[];
  } catch (err) {
    throw new Error(
      `Biome printed no JSON report: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const out: Finding[] = [];
  for (const d of diagnostics) {
    let path = projectFile(input, "package.json");
    let line = 0;
    let column = 0;
    // Go's json.Marshal of a map: the keys come out sorted.
    let file = "";
    let span = "";
    const l = d.location;
    if (l !== null && l.path.file !== "") {
      path = projectFile(input, l.path.file);
      file = `"file":${quoteJSONString(l.path.file, true)},`;
      const offsets = (l.span?.items() ?? []) as bigint[];
      const [from] = offsets;
      if (offsets.length === 2 && from !== undefined) {
        [line, column] = biomeLineAndColumn(l.sourceCode, from);
        span = `,"span":[${offsets.map(String).join(",")}]`;
      }
    }
    const rule = d.category === "" ? "biome-diagnostic" : d.category;
    out.push(
      repoFinding(input, lintExistingID, {
        tool: "biome",
        rule,
        level: biomeLevel(d.severity),
        message: d.description,
        path,
        line,
        column,
        raw:
          `{"category":${quoteJSONString(d.category, true)},` +
          `"description":${quoteJSONString(d.description, true)},${file}` +
          `"severity":${quoteJSONString(d.severity, true)}${span}}`,
      }),
    );
  }
  return out;
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

function packageOf(input: Input): NonNullable<Input["context"]["package"]> {
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("lint.existing examines packages");
  }
  return pkg;
}

/**
 * projectFile is a path relative to the folder of the package as a path
 * relative to the project root. The paths come from a linter that ran project
 * code, so the result is confined to the project root, whatever they hold.
 */
export function projectFile(input: Input, rel: string): string {
  const p = join("/", packageOf(input).path, rel);
  return p.startsWith("/") ? p.slice(1) : p;
}
