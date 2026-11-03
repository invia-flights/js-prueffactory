// The Go build wrote the report schema 0.4.0, in which a Finding has no
// in_documentation. Its recorded answers (oracle files that may not be
// edited) hold Reports of that shape. The oracle tests read them through
// these helpers, so that everything else a recording says is still compared
// as recorded: the Go Report is upgraded to the schema 0.5.0 before this
// build reads it, or this build's Report is written back as Go wrote it
// before it is compared.
import { type ObjectShape } from "../gocompat/json.ts";
import { FindingShape } from "./types.ts";

/** goSchemaVersion is the schema version the Go build wrote. */
const goSchemaVersion = "0.4.0";
/** schemaVersion is the schema version of this build. */
const schemaVersion = "0.5.0";

/** GoFindingShape is FindingShape as the Go build wrote a Finding. */
export const GoFindingShape: ObjectShape = {
  kind: "object",
  fields: FindingShape.fields.filter((f) => f.key !== "in_documentation"),
};

/**
 * asGoReport turns the text of a report.json of this build into the text the
 * Go build wrote for the same Report: the old schema version and no
 * in_documentation.
 */
export function asGoReport(json: string): string {
  return json
    .split("\n")
    .filter((line) => !line.trimStart().startsWith('"in_documentation":'))
    .join("\n")
    .replace(
      `"schema_version": "${schemaVersion}"`,
      `"schema_version": "${goSchemaVersion}"`,
    );
}

/**
 * upgradeGoDocument returns the Report document the Go build wrote as the
 * schema 0.5.0 holds it: the new version, and in_documentation false on every
 * Finding (the Go build had no Documentation). A document of another shape
 * is returned as it is.
 */
export function upgradeGoDocument(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return doc;
  }
  const report = doc as Record<string, unknown>;
  if (report.schema_version === goSchemaVersion) {
    report.schema_version = schemaVersion;
  }
  if (Array.isArray(report.findings)) {
    for (const f of report.findings as unknown[]) {
      if (typeof f === "object" && f !== null && !Array.isArray(f)) {
        const finding = f as Record<string, unknown>;
        finding.in_documentation ??= false;
      }
    }
  }
  return report;
}

/** UpgradedText is a Go report.json as the schema 0.5.0 holds it. */
export interface UpgradedText {
  text: string;
  /**
   * shift maps a byte offset of the Go text to the offset of the same place
   * in the upgraded text, for the oracle cases that splice bytes.
   */
  shift: (offset: number) => number;
}

/**
 * upgradeGoText is upgradeGoDocument on the bytes of a report.json: it
 * changes the schema version and inserts a line "in_documentation": false
 * after every line of in_test_code, and keeps everything else, so a case
 * that damages the text at a byte offset still can.
 */
export function upgradeGoText(text: string): UpgradedText {
  const inserts: { at: number; length: number }[] = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/^( *)"in_test_code": [a-z]+,\n/gm)) {
    const end = m.index + m[0].length;
    const line = `${m[1] ?? ""}"in_documentation": false,\n`;
    out += text.slice(last, end) + line;
    inserts.push({ at: end, length: line.length });
    last = end;
  }
  out += text.slice(last);
  return {
    text: out.replace(
      `"schema_version": "${goSchemaVersion}"`,
      `"schema_version": "${schemaVersion}"`,
    ),
    shift: (offset) =>
      offset + inserts.reduce((n, i) => (offset >= i.at ? n + i.length : n), 0),
  };
}
