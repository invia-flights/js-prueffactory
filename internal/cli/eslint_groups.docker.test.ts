// Seam A with a real Docker daemon, for the rule groups of tests.smells and
// deps.engines in the combined ESLint run (Go: cli_eslint_groups_docker_test.go).
// The Go tests ran the default Selection; these select the Check they read.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { findingsOf, lintReport, packageExecution } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("a committed .only is a Gate and a pending test is a warning", async (t) => {
  const original = copyProject(t, "committed-only");
  // node:test files are covered, because test is a test-case name and their
  // imports are followed.
  writeFileSync(
    join(original, "test", "node.test.mjs"),
    "import { test } from 'node:test';\n\ntest.only('focused', () => {});\n",
  );

  const r = await realRun(t, ["test", original, "--only", "tests.smells"]);

  assert.equal(r.code, 1, `a committed .only is a Gate\n${r.stderr}`);
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = packageExecution(r, s, "tests.smells");
  assert.equal(exec.status, "completed");
  assert.equal(exec.outcome, "failed", String(exec.reason));

  const got: Record<string, string> = {};
  for (const f of findingsOf(s, "tests.smells")) {
    got[`${String(f.rule_id)}@${f.locations[0]?.path ?? ""}`] = f.gate
      ? "gate"
      : "warning";
  }
  assert.deepEqual(got, {
    "mocha/no-exclusive-tests@test/add.test.js": "gate",
    "mocha/no-exclusive-tests@test/node.test.mjs": "gate",
    "mocha/no-pending-tests@test/add.test.js": "warning",
  });
});

test("new Buffer is a warning of deps.engines on the package's Node version", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, ["test", original, "--only", "deps.engines"]);

  assert.equal(r.code, 0, `deps.engines findings are warnings\n${r.stderr}`);
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = packageExecution(r, s, "deps.engines");
  assert.equal(exec.status, "completed", String(exec.reason));
  const found = findingsOf(s, "deps.engines");
  assert.equal(found.length, 1, "the one new Buffer()");
  const f = found[0];
  assert.ok(f);
  assert.equal(f.rule_id, "n/no-deprecated-api");
  assert.ok(!f.gate && f.severity === "warning");
  assert.equal(f.locations[0]?.path, "src/index.js");
  assert.equal(f.locations[0].start?.line, 6);
  assert.ok(f.message.includes("new Buffer()"), f.message);
});

test("only the rule groups of selected Checks are switched on", async (t) => {
  const original = copyProject(t, "deprecations");

  const r = await realRun(t, ["test", original, "--only", "deps.engines"]);

  assert.equal(r.code, 0, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);
  assert.equal(findingsOf(s, "deps.engines").length, 1);
  for (const f of s.findings) {
    assert.equal(f.check_id, "deps.engines", "only deps.engines is selected");
  }
  // The config's hash covers the groups that were on.
  for (const c of s.contexts) {
    for (const tool of c.tools) {
      if (tool.name === "eslint-config") {
        assert.notEqual(tool.digest, null);
      }
    }
  }
});

test("quality-signals: the complex function shows up above every threshold and nothing is a Gate", async (t) => {
  const original = copyProject(t, "quality-signals");

  const r = await realRun(t, ["test", original, "--only", "quality.metrics"]);

  assert.equal(r.code, 0, `metrics are measurements\n${r.stderr}`);
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = packageExecution(r, s, "quality.metrics");
  assert.equal(exec.status, "completed", String(exec.reason));
  assert.equal(
    findingsOf(s, "quality.metrics").length,
    0,
    "a measurement without Findings",
  );

  const metrics = new Map<string, number>();
  for (const m of s.metrics) {
    if (m.check_id !== "quality.metrics") {
      continue;
    }
    if (m.value === null) {
      assert.fail(`metric ${m.name} has no value: ${String(m.reason)}`);
    }
    metrics.set(m.name, m.value);
  }
  const num = (name: string): number => metrics.get(name) ?? Number.NaN;
  for (const name of [
    "functions_above_cyclomatic_20",
    "functions_above_cognitive_15",
    "functions_above_length_50",
  ]) {
    assert.equal(num(name), 1, `${name}: only shippingCost is that complex`);
  }
  assert.ok(
    num("cyclomatic_max") > 20 &&
      num("cognitive_max") > 15 &&
      num("length_max") > 50,
    `maxima ${JSON.stringify([...metrics])}, want above every threshold`,
  );
  // The functions of Source code have the 50th percentile below every
  // threshold. The long describe callback and the arrow functions in
  // test/*.test.js are Test code and are not measured.
  assert.ok(
    num("functions") >= 5 &&
      num("cyclomatic_p50") < 20 &&
      num("length_p50") < 50,
    JSON.stringify([...metrics]),
  );

  assert.equal(
    exec.artifact_ids.length,
    1,
    `artifact IDs ${JSON.stringify(exec.artifact_ids)}, want the per-function values`,
  );
  const artifact = s.artifacts.find((a) => a.id === exec.artifact_ids[0]);
  assert.ok(artifact);
  const doc = JSON.parse(
    readFileSync(join(r.reportDir, artifact.path), "utf8"),
  ) as {
    functions: {
      path: string;
      name: string;
      cyclomatic: number;
      cognitive: number;
      length: number;
    }[];
  };
  const shipping: string[] = [];
  for (const f of doc.functions) {
    assert.ok(
      f.path.startsWith("src/"),
      `the artifact holds a function outside Source code: ${f.path} ${f.name}`,
    );
    if (f.path === "src/shipping.js") {
      shipping.push(f.name);
      assert.ok(
        f.cyclomatic > 20 && f.cognitive > 15 && f.length > 50,
        `shippingCost ${JSON.stringify(f)}, want above every threshold`,
      );
    }
  }
  assert.deepEqual(shipping.sort(), ["Function 'shippingCost'"]);
  assert.equal(s.summary.gates, 0);
});
