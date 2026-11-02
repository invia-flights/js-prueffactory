// Knip's JSON report as quality.unused reads it (Go: the knipItem and
// knipIssue types of quality_unused.go, and the decoding in correctKnip).
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";

/** KnipItem is one entry of an issue type in Knip's JSON report. */
export interface KnipItem {
  name: string;
  line: number;
  col: number;
}

/**
 * KnipIssue is the report's entry for one file. Types that Knip adds later
 * are ignored.
 */
export interface KnipIssue {
  file: string;
  files: KnipItem[];
  dependencies: KnipItem[];
  devDependencies: KnipItem[];
  optionalPeerDependencies: KnipItem[];
  unlisted: KnipItem[];
  binaries: KnipItem[];
  unresolved: KnipItem[];
  exports: KnipItem[];
  types: KnipItem[];
}

const itemType =
  'struct { Name string "json:\\"name\\""; Line int "json:\\"line\\""; Col int "json:\\"col\\"" }';
const itemSchema: Schema = {
  kind: "struct",
  type: itemType,
  fields: [
    { name: "name", schema: { kind: "string" } },
    { name: "line", schema: { kind: "int" } },
    { name: "col", schema: { kind: "int" } },
  ],
};
const itemList: Schema = {
  kind: "slice",
  type: "[]" + itemType,
  elem: itemSchema,
};

const listFields = [
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "exports",
  "types",
] as const;

const issueType = "checks.knipIssue";
const reportSchema: Schema = {
  kind: "struct",
  type: "struct { Issues []checks.knipIssue }",
  fields: [
    {
      name: "issues",
      schema: {
        kind: "slice",
        type: "[]" + issueType,
        elem: {
          kind: "struct",
          type: issueType,
          fields: [
            { name: "file", schema: { kind: "string" } },
            ...listFields.map((name) => ({ name, schema: itemList })),
          ],
        },
      },
    },
  ],
};

interface RawItem {
  name: string;
  line: bigint;
  col: bigint;
}

interface RawIssue {
  file: string;
  [list: string]: unknown;
}

/**
 * parseKnipReport decodes Knip's JSON report as Go's json.Unmarshal does. It
 * throws where Go returned an error: invalid JSON, or a value of the wrong
 * type.
 */
export function parseKnipReport(stdout: Uint8Array): KnipIssue[] {
  const report = unmarshal(stdout, reportSchema) as {
    issues: { items(): RawIssue[] } | null;
  };
  return (report.issues?.items() ?? []).map((raw) => {
    const issue = { file: raw.file } as KnipIssue;
    for (const name of listFields) {
      const list = raw[name] as { items(): RawItem[] } | null;
      issue[name] = (list?.items() ?? []).map((i) => ({
        name: i.name,
        line: Number(i.line),
        col: Number(i.col),
      }));
    }
    return issue;
  });
}
