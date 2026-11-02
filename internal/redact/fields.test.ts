import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Shape } from "../gocompat/json.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { ReportShape } from "../resultset/types.ts";
import { closedPaths } from "../schema/closed.ts";
import { goOracle } from "./oracle.testutil.ts";
import { closedField, IdentifierTag, VocabularyTag } from "./redact.ts";

// freeTextFields lists, by JSON path, every plain string field of the Report
// that holds text and not a word of a vocabulary or an identifier. Redaction
// replaces a registered value in these fields, and only here.
//
// A string field is in one of three classes: closed (the JSON Schema fixes its
// value, or it has the vocabulary tag), an identifier (the identifier tag), or
// text (this list). A field added to the Report must be put in one of them on
// purpose: the test below fails for a field that is in none, and for an entry
// here that is no longer a text field, so the list cannot go stale unseen.
const freeTextFields = [
  "producer.version",
  "producer.vcs_revision",
  "run.docker.server_version",
  "run.docker.api_version",
  "contexts.npm_version",
  "contexts.node.version",
  "contexts.node.not_checked_versions",
  "contexts.tools.version",
  "services.reason",
  "benchmark.areas.parts.label",
  "benchmark.areas.parts.reason",
  "benchmark.side_indicators.label",
  "benchmark.side_indicators.reason",
  "benchmark.fingerprint.fields.advisory_database_date",
  "benchmark.fingerprint.fields.runtimes.node_version",
  "benchmark.fingerprint.fields.runtimes.npm_version",
  "checks.reason",
  "checks.command",
  "checks.tool.version",
  "test_cases.full_title",
  "test_cases.suite_path",
  "test_cases.never_run_reason",
  "test_cases.attempts.error",
  "findings.title",
  "findings.message",
  "findings.expected",
  "findings.actual",
  "findings.locations.snippet.text",
  "findings.evidence.text",
  "findings.reproduction.rerun_command",
  "findings.reproduction.test.full_title",
  "findings.reproduction.test.native_command",
  "findings.limitations",
  "metrics.reason",
  "limitations.message",
  "report_completeness.redaction.reason",
];

interface StringField {
  path: string;
  tag: string;
}

// stringFields lists the string fields reachable from a shape: the ones the
// Redactor looks at (a string, a pointer to one or a slice of them).
function stringFields(shape: Shape, path: string, out: StringField[]): void {
  switch (shape.kind) {
    case "nullable":
    case "array":
      stringFields(shape.of, path, out);
      return;
    case "object":
      for (const f of shape.fields) {
        const child = path === "" ? f.key : `${path}.${f.key}`;
        let s = f.shape;
        while (
          s.kind === "nullable" ||
          (s.kind === "array" && s.of.kind === "string")
        ) {
          s = s.of;
        }
        if (s.kind === "string") {
          out.push({ path: child, tag: f.redact ?? "" });
        } else {
          stringFields(f.shape, child, out);
        }
      }
      return;
    default:
      return;
  }
}

// The fields Go declared with a named string type (RunStatus, ExecStatus and
// so on). Go's walk skipped them by their type; the shapes do not keep Go
// types, so the port relies on the schema closing each of them.
const namedTypeFields = [
  "run.status",
  "checks.applicability",
  "checks.status",
  "checks.outcome",
  "test_cases.outcome",
  "test_cases.attempts.outcome",
  "findings.kind",
  "findings.severity",
  "findings.confidence",
];

describe("the string fields of the Report", () => {
  // Go: TestEveryStringFieldOfTheReportIsClassified
  test("every string field of the Report is classified", () => {
    const fields: StringField[] = [];
    stringFields(ReportShape, "", fields);
    assert.ok(
      fields.length >= 80,
      `found only ${String(fields.length)} string fields`,
    );
    const text = new Set(freeTextFields);
    const unclassified: string[] = [];
    const stale: string[] = [];
    const seenText = new Set<string>();
    for (const f of fields) {
      const closed = closedField(f.path, f.tag);
      if (closed && text.has(f.path)) {
        stale.push(f.path + " is closed, remove it from freeTextFields");
      } else if (closed || f.tag === IdentifierTag) {
        // classified
      } else if (text.has(f.path)) {
        seenText.add(f.path);
      } else {
        unclassified.push(f.path);
      }
      assert.ok(
        f.tag === "" || f.tag === IdentifierTag || f.tag === VocabularyTag,
        `${f.path} has the unknown redact tag ${f.tag}`,
      );
      if (f.tag === IdentifierTag && text.has(f.path)) {
        stale.push(f.path + " is an identifier, remove it from freeTextFields");
      }
    }
    for (const p of freeTextFields) {
      if (!seenText.has(p)) {
        stale.push(
          p +
            " is in freeTextFields but is not a plain text field of the Report",
        );
      }
    }
    assert.deepEqual(
      sortStrings(unclassified),
      [],
      "these string fields are not classified. If the JSON Schema should fix the value, give it an enum, a const or a pattern; " +
        `if it holds a word of a vocabulary of the code, tag it "${VocabularyTag}"; if it holds a path, an ID or a name of the project, tag it "${IdentifierTag}"; ` +
        "if it holds text, add it to freeTextFields",
    );
    assert.deepEqual(sortStrings(stale), [], "freeTextFields is out of date");
  });

  test("the fields of a named string type in Go are closed by the schema", () => {
    for (const p of namedTypeFields) {
      assert.ok(closedPaths().has(p), `${p} is not closed`);
    }
  });

  test("the closed paths are the ones the Go build read from the schema", () => {
    assert.deepEqual(sortStrings([...closedPaths()]), goOracle.closedPaths);
  });
});
