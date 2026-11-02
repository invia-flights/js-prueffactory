import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { marshal, type Shape } from "../gocompat/json.ts";
import { sortStrings, utf8Length } from "../gocompat/strings.ts";
import { goldenScored } from "../resultset/helpers.testutil.ts";
import { populated } from "../resultset/resultsettest/populated.testutil.ts";
import { ReportShape, type Set as ResultSet } from "../resultset/types.ts";
import { validate } from "../resultset/validate.ts";
import { validate as validateSchema } from "../schema/schema.ts";
import {
  closedField,
  MinLength,
  newRedactor,
  type Redactor,
} from "./redact.ts";

// schemaWords returns every string the Report schema fixes with an enum or a
// const, long enough for the Redactor to take (add ignores shorter values), and
// the pieces of the shapes it fixes with a pattern: the hex digits of a hash,
// the digits and prefix of an ID. They are what an unlucky secret could be a
// substring of.
function schemaWords(): string[] {
  const doc = JSON.parse(
    readFileSync(
      new URL("../schema/report.schema.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  const seen = new Set(["abab", "0001", "sha256", "E-00", "F-000"]);
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== "object" || n === null) {
      return;
    }
    for (const [key, sub] of Object.entries(n)) {
      if (key === "const" && typeof sub === "string") {
        seen.add(sub);
      } else if (key === "enum" && Array.isArray(sub)) {
        for (const e of sub) {
          if (typeof e === "string") {
            seen.add(e);
          }
        }
      }
      walk(sub);
    }
  };
  walk(doc);
  const words = sortStrings(
    [...seen].filter((w) => utf8Length(w) >= MinLength),
  );
  assert.ok(
    words.length >= 30,
    `only ${String(words.length)} schema words found`,
  );
  return words;
}

// closedValues lists every closed string of the set (schema-fixed or tagged
// vocabulary) by JSON Pointer: what redaction must never change.
function closedValues(s: ResultSet): string[] {
  const out: string[] = [];
  const walk = (v: unknown, shape: Shape, ptr: string, path: string): void => {
    switch (shape.kind) {
      case "nullable":
        if (v !== null && v !== undefined) {
          walk(v, shape.of, ptr, path);
        }
        return;
      case "array":
        if (Array.isArray(v)) {
          v.forEach((item: unknown, i) => {
            walk(item, shape.of, `${ptr}/${String(i)}`, path);
          });
        }
        return;
      case "object":
        for (const f of shape.fields) {
          const child = path === "" ? f.key : `${path}.${f.key}`;
          const value = (v as Record<string, unknown>)[f.key];
          if (closedField(child, f.redact)) {
            out.push(`${ptr}/${f.key}=${JSON.stringify(value)}`);
          } else {
            walk(value, f.shape, `${ptr}/${f.key}`, child);
          }
        }
        return;
      default:
        return;
    }
  };
  walk(s, ReportShape, "", "");
  return out;
}

// Both modes of the Report: the test mode one with every section but the
// benchmark details, and a benchmark mode one.
const reports: Record<string, () => ResultSet> = {
  "test mode": populated,
  "benchmark mode": () => goldenScored("benchmark-pass"),
};

const registrations: Record<string, (r: Redactor, values: string[]) => void> = {
  add: (r, values) => {
    r.add(...values);
  },
  addTextOnly: (r, values) => {
    r.addTextOnly(...values);
  },
};

function assertIntact(
  build: () => ResultSet,
  redact: (r: Redactor) => void,
  context: string,
) {
  const before = closedValues(build());
  const s = build();
  const r = newRedactor();
  redact(r);
  r.apply(s);
  assert.deepEqual(
    closedValues(s),
    before,
    `${context}: a closed field changed`,
  );
  assert.deepEqual(
    validate(s),
    [],
    `${context}: the redacted Report is inconsistent`,
  );
  assert.deepEqual(
    validateSchema(Buffer.from(marshal(s, ReportShape), "utf8")),
    [],
    `${context}: the redacted Report fails the schema`,
  );
}

describe("schema words", () => {
  // Go: TestNoRegisteredSchemaWordMakesTheReportInvalid. A registered value
  // that is also a word of the schema, such as root, pass or info, must not
  // turn a field with a closed vocabulary into something else. As in Go, the
  // redacted Report is validated against the schema; the test also checks the
  // cause directly: no closed field changes, and the result set rules hold.
  const words = schemaWords();
  for (const [mode, build] of Object.entries(reports)) {
    test(`${mode}: no registered schema word changes a closed field`, () => {
      assert.deepEqual(
        validate(build()),
        [],
        `${mode} fixture before redaction`,
      );
      for (const [how, register] of Object.entries(registrations)) {
        for (const word of words) {
          assertIntact(
            build,
            (r) => {
              register(r, [word]);
            },
            `${mode}, ${how}, ${word}`,
          );
        }
        assertIntact(
          build,
          (r) => {
            register(r, words);
          },
          `${mode}, ${how}, every schema word at once`,
        );
      }
      const half = Math.floor(words.length / 2);
      assertIntact(
        build,
        (r) => {
          r.add(...words.slice(0, half));
          r.addTextOnly(...words.slice(half));
        },
        `${mode}, half with add and half with addTextOnly`,
      );
    });
  }
});

describe("vocabulary fields", () => {
  // Go: TestVocabularyFieldsStayAndTextAroundThemIsRedacted. The words of the
  // code's own vocabularies that the schema leaves open (reason codes, Check
  // IDs, tool names, evidence kinds) stay as they are too, while the same word
  // is still replaced in the text around them.
  for (const [how, register] of Object.entries(registrations)) {
    test(`${how}: vocabulary fields stay and the text around them is redacted`, () => {
      const r = newRedactor();
      register(r, [
        "root",
        "mocha",
        "syntax",
        "credentials",
        "stack",
        "primary",
      ]);
      const s = populated();
      const code = "missing_registry_credentials";
      const check = s.checks[0];
      const f = s.findings[0];
      const loc = f?.locations[0];
      const ev = f?.evidence[0];
      const lim = s.limitations[0];
      assert.ok(check && f && loc?.snippet && ev && lim);
      check.reason_code = code;
      check.reason = "no credentials for root";
      f.title = "mocha root hook failed";
      loc.snippet.text = "const root = 1";
      ev.text = "root: syntax error";
      lim.reason_code = code;
      lim.message = "root credentials";

      r.apply(s);

      assert.equal(check.reason_code, code, "reason code");
      assert.equal(lim.reason_code, code, "limitation reason code");
      assert.equal(check.tool?.name, "mocha", "tool name");
      assert.equal(f.check_id, "tests.existing", "check ID");
      assert.equal(ev.kind, "stack", "evidence kind");
      assert.equal(ev.origin, "mocha", "evidence origin");
      assert.equal(loc.role, "primary", "location role");
      assert.equal(loc.path_base, "project_root", "path base");
      assert.equal(check.reason, "no [REDACTED] for [REDACTED]");
      assert.equal(f.title, "[REDACTED] [REDACTED] hook failed");
      assert.equal(loc.snippet.text, "const [REDACTED] = 1");
      assert.equal(ev.text, "[REDACTED]: [REDACTED] error");
      assert.equal(lim.message, "[REDACTED] [REDACTED]");
    });
  }
});
