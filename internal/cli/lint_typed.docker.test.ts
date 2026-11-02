// Seam A with a real Docker daemon, for lint.typed (Go:
// lint_typed_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactOf,
  findingsOf,
  lintReport,
  oneExecution,
  partOf,
} from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

test("lint.typed reports floating and misused promises and ignores the disable comment", async (t) => {
  const original = copyProject(t, "typed-js");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "lint.typed"]);

  assert.equal(
    r.code,
    0,
    `the Findings are warnings and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.typed");
  assert.equal(exec.status, "completed", r.stderr);
  const command = exec.command.join(" ");
  for (const flag of [
    "--no-config-lookup",
    "--no-inline-config",
    "--format json",
  ]) {
    assert.ok(command.includes(flag), command);
  }

  // The lines of src/orders.js: 19 floats a promise, 29 does too behind an
  // eslint-disable comment, 38 hands an async callback to forEach, 49 awaits a
  // number. test/orders.test.js line 7 floats a promise in Test code.
  const got = new Map<string, (typeof s.findings)[number]>();
  for (const f of findingsOf(s, "lint.typed")) {
    assert.ok(
      !f.gate && f.severity === "warning" && f.confidence === "likely",
      `finding ${JSON.stringify(f)}, want a likely warning without Gate`,
    );
    got.set(
      `${String(f.rule_id)}|${f.locations[0]?.path ?? ""}|${String(f.locations[0]?.start?.line)}`,
      f,
    );
  }
  const floating = "@typescript-eslint/no-floating-promises";
  const misused = "@typescript-eslint/no-misused-promises";
  const thenable = "@typescript-eslint/await-thenable";
  for (const [rule, path, line] of [
    [floating, "src/orders.js", 19],
    [floating, "src/orders.js", 29],
    [misused, "src/orders.js", 38],
    [thenable, "src/orders.js", 49],
    [floating, "test/orders.test.js", 7],
  ] as const) {
    const f = got.get(`${rule}|${path}|${String(line)}`);
    assert.ok(
      f,
      `no finding ${rule} ${path}:${String(line)} among ${[...got.keys()].join(", ")}`,
    );
    assert.equal(f.in_test_code, path === "test/orders.test.js", path);
  }
  assert.equal(got.size, 5, "exactly the five above");

  // The rule list and its hash are recorded.
  assert.ok(
    artifactOf(s, exec, "C-0002-rules.json"),
    JSON.stringify(s.artifacts),
  );
  assert.ok(
    s.contexts.some((c) =>
      c.tools.some(
        (tool) =>
          tool.name === "typed-lint-rules" && tool.digest?.length === 64,
      ),
    ),
    "the Context does not record the rule list hash",
  );
});

test("lint.typed accepts a chain that ends in a rejection handler of type any or Function and still reports the others", async (t) => {
  const original = copyProject(t, "typed-js-handlers");

  const r = await realRun(t, ["test", original, "--only", "lint.typed"]);

  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);
  assert.equal(oneExecution(s, "lint.typed").status, "completed", r.stderr);
  // src/handler.js: the chains that end in .catch(next), .then(f, onError) and
  // .catch(onError).finally(f) (lines 18 to 33) are handled. Line 38 drops a
  // promise and line 43 has no rejection handler.
  const lines: number[] = [];
  for (const f of findingsOf(s, "lint.typed")) {
    assert.ok(
      f.rule_id === "@typescript-eslint/no-floating-promises" &&
        f.locations[0]?.path === "src/handler.js",
      `finding ${JSON.stringify(f)}, want only floating promises in src/handler.js`,
    );
    lines.push(f.locations[0].start?.line ?? 0);
  }
  assert.deepEqual(
    lines.sort((a, b) => a - b),
    [38, 43],
  );
});

test("lint.typed leaves the top-level registrations of node:test alone and still reports a real floating promise", async (t) => {
  const original = copyProject(t, "typed-js-node-test");

  const r = await realRun(t, ["test", original, "--only", "lint.typed"]);

  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);
  assert.equal(oneExecution(s, "lint.typed").status, "completed", r.stderr);
  // Both test files register tests, hooks and suites at the top level, in
  // every form of import. Only the assert.rejects of
  // test/registration.test.js line 29 is a promise nobody awaits.
  const findings = findingsOf(s, "lint.typed");
  assert.equal(
    findings.length,
    1,
    findings
      .map(
        (f) =>
          `${f.locations[0]?.path ?? ""}:${String(f.locations[0]?.start?.line)}`,
      )
      .join(", "),
  );
  const f = findings[0];
  assert.ok(f);
  assert.equal(f.rule_id, "@typescript-eslint/no-floating-promises");
  assert.equal(f.locations[0]?.path, "test/registration.test.js");
  assert.equal(f.locations[0].start?.line, 29);
  assert.ok(f.in_test_code);
});

test("the Benchmark counts only the Source code hits of lint.typed and records the rule list in the fingerprint", async (t) => {
  const original = copyProject(t, "typed-js");

  const r = await realRun(t, ["benchmark", original, "--only", "lint.typed"]);

  assert.equal(r.code, 0, r.stderr);
  const s = lintReport(r);
  const part = partOf(s, "typed_lint");
  assert.ok(
    part.state === "measured" && part.raw_value !== null && part.score !== null,
    JSON.stringify(part),
  );
  // Four Source code hits in three rules: floating twice (damped to 2),
  // misused once and await-thenable once, so n_eff is 4; the hit in Test code
  // does not count.
  assert.equal(part.raw_value, 4);
  assert.equal(part.n_eff, 4);
  const hash = s.benchmark.fingerprint?.fields.typed_lint_rules_hash;
  assert.equal(hash?.length, 64, "the typed lint rule list hash");
  assertNothingLeft(r);
});
