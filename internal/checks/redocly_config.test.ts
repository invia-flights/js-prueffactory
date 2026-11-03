// The pinned Redocly configuration of api.lint (config/redocly.yaml) records
// the audit of Redocly's "spec" ruleset against the OpenAPI and Swagger text:
// a rule is an `error` only next to a sentence that requires what it checks.
// These tests keep that record whole. They read the file as text, because the
// sentences are comments.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Redocly } from "../toolset/redocly.ts";

const config = readFileSync(
  new URL("config/redocly.yaml", import.meta.url),
  "utf8",
);

/** Setting is one rule of the file with the comment lines right above it. */
interface Setting {
  /** block is `rules`, `oas2Rules`, `oas3_0Rules`, `oas3_1Rules` or `oas3_2Rules`. */
  block: string;
  rule: string;
  severity: string;
  comment: string[];
}

function settings(): Setting[] {
  const out: Setting[] = [];
  let block = "";
  let comment: string[] = [];
  for (const line of config.split("\n")) {
    const text = line.trim();
    if (text.startsWith("#")) {
      comment.push(text.slice(1).trim());
      continue;
    }
    const rule = /^ {2}([a-zA-Z0-9-]+): (error|warn|off)$/.exec(line);
    if (rule?.[1] !== undefined && rule[2] !== undefined) {
      out.push({ block, rule: rule[1], severity: rule[2], comment });
    } else if (/^\w+:/.test(line)) {
      block = line.slice(0, line.indexOf(":"));
    }
    comment = [];
  }
  return out;
}

/** quotes are the lines of the form `<version> <section>: "<sentence>"`. */
function quotes(s: Setting): { version: string; sentence: string }[] {
  const out = [];
  for (const line of s.comment) {
    const m = /^(\S+) [0-9.]+: "(.*)"$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      out.push({ version: m[1], sentence: m[2] });
    }
  }
  return out;
}

const familyOf: Record<string, string> = {
  oas2Rules: "2.0",
  oas3_0Rules: "3.0.",
  oas3_1Rules: "3.1.",
  oas3_2Rules: "3.2.",
};

test("the audit was made for the pinned Redocly version", () => {
  const m = /^# audited-for-redocly: (\S+)$/m.exec(config);
  assert.equal(
    m?.[1],
    Redocly.version,
    "internal/toolset/redocly.ts pins another Redocly version than the one the audit of config/redocly.yaml was made for: repeat the audit for every rule and OpenAPI version that the new version adds to its spec ruleset (see AGENTS.md), then change the version in the config",
  );
});

test("a rule is an error only next to a sentence of the specification that requires it", () => {
  const all = settings();
  assert.ok(all.length > 30, "the settings were not read");
  const requirement = /\b(MUST|REQUIRED|SHALL|Required)\b/;
  for (const s of all) {
    const where = `${s.block}.${s.rule}`;
    const found = quotes(s);
    const family = familyOf[s.block];
    for (const q of found) {
      if (family !== undefined) {
        assert.ok(
          q.version.startsWith(family),
          `${where} quotes ${q.version}, which is not a version of ${s.block}`,
        );
      }
    }
    switch (s.severity) {
      case "error":
        assert.ok(
          found.some((q) => requirement.test(q.sentence)),
          `${where} is an error without a quoted sentence that has MUST, MUST NOT, REQUIRED or SHALL`,
        );
        break;
      case "warn":
        assert.ok(
          s.comment.some((c) => c.startsWith("no requirement:")),
          `${where} is a warning without a "no requirement:" comment that says why`,
        );
        break;
      default:
        assert.fail(`${where} is ${s.severity}: the audit sets error or warn`);
    }
  }
});

test("nullable-type-sibling and path-not-include-query are warnings in every version", () => {
  const all = settings();
  for (const rule of ["nullable-type-sibling", "path-not-include-query"]) {
    const found = all.filter((s) => s.rule === rule);
    assert.ok(found.length > 0, `${rule} is not set`);
    for (const s of found) {
      assert.equal(s.severity, "warn", `${s.block}.${rule}`);
    }
  }
});

test("every rule of Redocly's spec ruleset 2.70.0 is set in the blocks of the versions that enable it", () => {
  // The rules the "spec" ruleset of Redocly 2.70.0 enables per version, read
  // from the image's own ruleset. A version block that does not set a rule
  // leaves Redocly's error in place, which the audit has not looked at.
  const expected: Record<string, string[]> = {
    rules: ["no-unresolved-refs", "struct"],
    oas2Rules: [
      "no-duplicated-tag-names",
      "no-identical-paths",
      "operation-operationId-unique",
      "operation-parameters-unique",
      "path-declaration-must-exist",
      "path-not-include-query",
      "path-parameters-defined",
      "spec-ref-siblings",
      "spec-strict-refs",
    ],
    oas3_0Rules: [
      "no-duplicated-tag-names",
      "no-example-value-and-externalValue",
      "no-identical-paths",
      "no-undefined-server-variable",
      "nullable-type-sibling",
      "operation-operationId-unique",
      "operation-parameters-unique",
      "path-declaration-must-exist",
      "path-not-include-query",
      "path-parameters-defined",
      "spec-components-invalid-map-name",
      "spec-ref-siblings",
      "spec-strict-refs",
    ],
    oas3_1Rules: [
      "no-duplicated-tag-names",
      "no-example-value-and-externalValue",
      "no-identical-paths",
      "no-undefined-server-variable",
      "operation-operationId-unique",
      "operation-parameters-unique",
      "path-declaration-must-exist",
      "path-not-include-query",
      "path-parameters-defined",
      "spec-components-invalid-map-name",
      "spec-ref-siblings",
      "spec-strict-refs",
    ],
    oas3_2Rules: [
      "no-duplicated-tag-names",
      "no-identical-paths",
      "no-undefined-server-variable",
      "operation-operationId-unique",
      "operation-parameters-unique",
      "path-declaration-must-exist",
      "path-not-include-query",
      "path-parameters-defined",
      "spec-components-invalid-map-name",
      "spec-discriminator-defaultMapping",
      "spec-example-values",
      "spec-no-invalid-encoding-combinations",
      "spec-no-invalid-tag-parents",
      "spec-querystring-parameters",
      "spec-ref-siblings",
      "spec-strict-refs",
    ],
  };
  const all = settings();
  for (const [block, rules] of Object.entries(expected)) {
    const set = all
      .filter((s) => s.block === block)
      .map((s) => s.rule)
      .sort();
    assert.deepEqual(set, rules, block);
  }
});
