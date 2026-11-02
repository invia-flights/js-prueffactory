import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { populated } from "../resultset/resultsettest/populated.testutil.ts";
import { goOracle } from "./oracle.testutil.ts";
import { newRedactor } from "./redact.ts";

function finding0(s: ReturnType<typeof populated>) {
  const f = s.findings[0];
  assert.ok(f !== undefined);
  return f;
}

describe("Redactor.explain", () => {
  // Go: TestExplainNamesTheFieldAndTheRuleButNotTheValue
  test("names the field and the rule but not the value", () => {
    // When the finished Report fails validation, the diagnostics must say
    // which field was rewritten and which rule registered the value, and
    // never print the value itself.
    const value = "hunter2-made-up-value";
    const r = newRedactor();
    r.addTextOnlyFrom("env-secret-name (.env DB_PASSWORD)", value);
    r.addFrom("gitleaks", "ghp_madeUpTokenForTheTest0123456789abcd");

    const s = populated();
    finding0(s).title = "login with " + value;
    finding0(s).message =
      "token ghp_madeUpTokenForTheTest0123456789abcd leaked";
    const check = s.checks[0];
    assert.ok(check !== undefined);
    check.reason = "fine";
    assert.equal(r.apply(s), 2);

    const lines = r.explain([
      "/findings/0/title: something is wrong",
      "/findings/0/locations/0/path_base: value must be 'project_root'",
      "/checks/0/reason: another problem",
      'execution number 1 has ID "x", want "E-0001"', // a consistency problem without a path
    ]);
    const text = lines.join("\n");

    for (const want of [
      "/findings/0/title",
      "env-secret-name (.env DB_PASSWORD)",
    ]) {
      assert.ok(text.includes(want), `the explanation lacks ${want}:\n${text}`);
    }
    for (const l of lines) {
      // Redaction never touched path_base, so the only line about it may say so.
      if (l.includes("path_base")) {
        assert.ok(l.includes("did not rewrite"), l);
      }
      if (l.includes("/checks/0/reason")) {
        assert.ok(l.includes("did not rewrite"), l);
      }
    }
    for (const secret of [value, "ghp_madeUpToken"]) {
      assert.ok(
        !text.includes(secret),
        `the explanation prints a secret value:\n${text}`,
      );
    }
    assert.ok(text.includes("gitleaks"), text);
  });

  // Go: TestExplainGroupsTheProblemsOfOneFieldAcrossArrayIndexes
  test("groups the problems of one field across array indexes", () => {
    const r = newRedactor();
    r.addTextOnlyFrom(".npmrc", "madeup-registry-token");
    const s = populated();
    s.findings.push(structuredClone(finding0(s)), structuredClone(finding0(s)));
    for (const f of s.findings) {
      f.title = "uses madeup-registry-token";
    }
    r.apply(s);

    const lines = r.explain([
      "/findings/0/title: x",
      "/findings/1/title: x",
      "/findings/2/title: x",
    ]);
    assert.ok(lines.length <= 3, lines.join("\n"));
    const text = lines.join("\n");
    assert.ok(
      text.includes("/findings/*/title") &&
        text.includes("3") &&
        text.includes(".npmrc"),
      text,
    );
  });

  // Go: TestExplainSaysSoWhenRedactionTouchedNoneOfTheFailingFields
  test("says so when redaction touched none of the failing fields", () => {
    const r = newRedactor();
    r.addFrom("gitleaks", "madeup-token-never-in-report");
    const s = populated();
    r.apply(s);
    const text = r.explain(["/findings/0/title: x"]).join("\n");
    assert.ok(text.includes("did not rewrite"), text);
    assert.deepEqual(newRedactor().explain(["/findings/0/title: x"]), []);
  });

  test("gives the Go build's lines word for word", () => {
    const r = newRedactor();
    r.addTextOnlyFrom(
      "env-secret-name (.env DB_PASSWORD)",
      "hunter2-made-up-value",
    );
    r.addFrom("gitleaks", "ghp_madeUpTokenForTheTest0123456789abcd");
    r.add("unnamed-made-up-value");
    const s = populated();
    finding0(s).title = "login with hunter2-made-up-value";
    finding0(s).message =
      "token ghp_madeUpTokenForTheTest0123456789abcd leaked unnamed-made-up-value";
    const check = s.checks[0];
    assert.ok(check !== undefined);
    check.reason = "fine";
    assert.equal(r.apply(s), goOracle.populated.count);
    assert.deepEqual(
      r.explain([
        "/findings/0/title: something is wrong",
        "/findings/0/locations/0/path_base: value must be 'project_root'",
        "/checks/0/reason: another problem",
        "/findings/0: object problem",
        "/findings/0/message: m",
        'execution number 1 has ID "x", want "E-0001"',
      ]),
      goOracle.populated.explain,
    );
  });
});
