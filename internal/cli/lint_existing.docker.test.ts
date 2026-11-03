// Seam A with a real Docker daemon and the public npm registry, for
// lint.existing: the project's own ESLint and Biome at their locked versions
// (Go: lint_existing_docker_test.go, lint_existing_nogate_docker_test.go).
//
// project-biome pins Biome 2.1.2 and project-biome-current the newest Biome
// 2.x. Biome 2.4 and later print another JSON document than 2.1 (a location
// with a plain path and start and end positions instead of a path object and
// a byte span); the Check reads both, and a test of each keeps it so.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  artifactOf,
  executionsOf,
  findingsOf,
  lintReport,
  oneExecution,
  partOf,
  type LintReport,
} from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import { type Finding, withoutSecretScan } from "./suites.testutil.ts";

function lintFindingsByRule(
  s: LintReport,
): Map<string, LintReport["findings"][number]> {
  return new Map(
    findingsOf(s, "lint.existing").map((f) => [String(f.rule_id), f]),
  );
}

test("lint.existing runs the project's own ESLint with its config and directives and fires a Gate for an error rule in Source code", async (t) => {
  const original = copyProject(t, "project-eslint");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 1, `exit 1 for the Gate\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.equal(exec.status, "completed");
  assert.equal(exec.outcome, "failed");
  assert.equal(exec.gate, 1);
  assert.equal(exec.tool?.name, "eslint");
  assert.ok(
    exec.tool.version?.startsWith("9."),
    `tool ${JSON.stringify(exec.tool)}, want the project's own ESLint 9 from the lockfile, not the toolset's`,
  );
  assert.equal(
    exec.command.join(" "),
    "node node_modules/eslint/bin/eslint.js --format json .",
  );

  const byRule = lintFindingsByRule(s);
  const unused = byRule.get("no-unused-vars");
  assert.ok(
    unused?.gate &&
      unused.severity === "error" &&
      unused.locations[0]?.path === "src/index.js" &&
      unused.locations[0].start?.line === 1,
    `no-unused-vars = ${JSON.stringify(unused)}, want a Gate at src/index.js:1`,
  );
  const eq = byRule.get("eqeqeq");
  assert.ok(eq && !eq.gate && eq.severity === "warning", "eqeqeq: a warning");
  assert.ok(
    !byRule.has("no-console"),
    "the project's own eslint-disable comment keeps its meaning: no-console is silenced",
  );
  assert.equal(byRule.size, 2, JSON.stringify([...byRule.keys()]));
  assert.ok(artifactOf(s, exec, "linters.json"), JSON.stringify(s.artifacts));
  // The install ran as a prerequisite and is reported as not selected.
  assert.deepEqual(withoutSecretScan(s.selection.prerequisites_run), [
    "package.install",
  ]);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("lint.existing runs Biome and retries without VCS when its ignore file cannot be found", async (t) => {
  const original = copyProject(t, "project-biome");

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 1, `exit 1 for the Gate\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.equal(exec.status, "completed");
  assert.equal(exec.gate, 1);
  assert.equal(exec.tool?.name, "biome");
  assert.equal(exec.tool.version, "2.1.2", "the project's Biome 2.1.2");
  assert.equal(
    exec.command.join(" "),
    "node node_modules/@biomejs/biome/bin/biome lint --vcs-enabled=false --reporter=json .",
    "the retry that produced the result",
  );

  const byRule = lintFindingsByRule(s);
  const debuggerHit = byRule.get("lint/suspicious/noDebugger");
  assert.ok(
    debuggerHit?.gate &&
      debuggerHit.locations[0]?.path === "src/index.js" &&
      debuggerHit.locations[0].start?.line === 2,
    `noDebugger = ${JSON.stringify(debuggerHit)}, want a Gate at src/index.js:2`,
  );
  const consoleHit = byRule.get("lint/suspicious/noConsole");
  assert.ok(
    consoleHit && !consoleHit.gate && consoleHit.severity === "warning",
    "noConsole: a warning",
  );
  const unusedHit = byRule.get("lint/correctness/noUnusedVariables");
  assert.ok(unusedHit && !unusedHit.gate, "noUnusedVariables: a warning");

  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "biome_vcs_disabled" &&
        l.check_id === "lint.existing",
    ),
    `limitations ${JSON.stringify(s.limitations)}, want the VCS override recorded`,
  );
  const artifact = artifactOf(s, exec, "linters.json");
  assert.ok(artifact, JSON.stringify(s.artifacts));
  const doc = readFileSync(join(r.reportDir, artifact.path), "utf8");
  assert.ok(
    doc.includes("--vcs-enabled=false") && doc.includes('"override"'),
    doc,
  );
  assertNothingLeft(r);
});

test("lint.existing reads the newest Biome 2.x: the Source code error is a Gate at its line and column, the same rule in Test code is not", async (t) => {
  const original = copyProject(t, "project-biome-current");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 1, `exit 1 for the Source code error\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.deepEqual(
    [exec.status, exec.outcome, exec.gate],
    ["completed", "failed", 1],
  );
  assert.equal(exec.tool?.name, "biome");
  assert.equal(exec.tool.version, "2.6.4", "the project's Biome 2.6.4");
  assert.equal(
    exec.command.join(" "),
    "node node_modules/@biomejs/biome/bin/biome lint --reporter=json .",
    "no retry: the configuration does not use the VCS integration",
  );

  const findings = findingsOf(s, "lint.existing");
  assert.deepEqual(
    findings.filter((f) => f.rule_id === "biome-config-error"),
    [],
    "Biome exited with 1 only because of its diagnostics",
  );
  const where = (f: Finding): string =>
    `${f.locations[0]?.path ?? ""}:${String(f.locations[0]?.start?.line)}:${String(f.locations[0]?.start?.column)}`;
  assert.deepEqual(
    findings.map((f) => [f.rule_id, where(f), f.severity, f.gate]).sort(),
    [
      ["lint/suspicious/noConsole", "src/index.js:3:3", "warning", false],
      ["lint/suspicious/noDebugger", "src/index.js:2:3", "error", true],
      ["lint/suspicious/noDebugger", "test/index.test.js:4:3", "error", false],
    ],
    "the Gate is the one in Source code",
  );
  const inTest = findings.find((f) => f.locations[0]?.path.startsWith("test/"));
  assert.equal(inTest?.in_test_code, true);
  assert.equal(s.summary.gates, 1);
  assert.deepEqual(
    s.limitations.filter((l) => l.reason_code === "biome_vcs_disabled"),
    [],
  );
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("with no error in Source code the Test code error of the newest Biome leaves the Run at exit code 0", async (t) => {
  const original = copyProject(t, "project-biome-current");
  writeFileSync(
    join(original, "src", "index.js"),
    "function main() {\n  return 1;\n}\n\nmodule.exports = { main };\n",
  );

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 0, `the only error is in Test code\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.deepEqual(
    [exec.status, exec.outcome, exec.gate],
    ["completed", "observations_only", 0],
  );
  const hits = findingsOf(s, "lint.existing");
  assert.deepEqual(
    hits.map((f) => [f.rule_id, f.severity, f.gate]),
    [["lint/suspicious/noDebugger", "error", false]],
  );
  assertNothingLeft(r);
});

test("a Biome configuration that Biome itself rejects is a Gate with Biome's own diagnostic as Evidence", async (t) => {
  const original = copyProject(t, "project-biome-current");
  writeFileSync(
    join(original, "biome.json"),
    '{\n  "files": { "includes": ["**/*.js"] },\n  "linter": { "enabled": "yes please" }\n}\n',
  );

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 1, `exit 1 for the rejected configuration\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.deepEqual([exec.status, exec.gate], ["completed", 1]);
  const findings = findingsOf(s, "lint.existing");
  assert.equal(findings.length, 1, JSON.stringify(findings));
  const f = findings[0];
  assert.deepEqual(
    [f?.rule_id, f?.gate, f?.severity, f?.locations[0]?.path],
    ["biome-config-error", true, "error", "biome.json"],
  );
  assert.equal(f?.evidence[0]?.trust, "untrusted_data");
  assert.ok(
    f.evidence[0].text.includes(
      "enabled has an incorrect type, expected a boolean, but received a string",
    ),
    f.evidence[0].text,
  );
  assertNothingLeft(r);
});

test("an error at the project's error level in Test code is an error without a Gate, and the Source code error stays a Gate", async (t) => {
  const original = copyProject(t, "project-eslint-test-code");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "lint.existing",
  ]);

  // The Source code error (no-unused-vars in src/index.js) is the one Gate.
  assert.equal(r.code, 1, `exit 1 for the Source code error\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.deepEqual([exec.status, exec.gate], ["completed", 1]);
  assert.equal(s.summary.gates, 1);
  const byRule = lintFindingsByRule(s);
  const source = byRule.get("no-unused-vars");
  assert.ok(source);
  assert.deepEqual(
    [source.gate, source.severity, source.in_test_code],
    [true, "error", false],
  );
  assert.equal(source.locations[0]?.path, "src/index.js");
  // The Test code error keeps its severity; it is only no Gate.
  const inTest = byRule.get("no-var");
  assert.ok(inTest);
  assert.deepEqual(
    [inTest.gate, inTest.severity, inTest.in_test_code],
    [false, "error", true],
  );
  assert.equal(inTest.locations[0]?.path, "test/index.test.js");
  // The Project linter part counts both errors, whatever their Gate.
  const part = partOf(s, "project_linter");
  assert.deepEqual([part.state, part.raw_value], ["measured", 2]);
  assertNothingLeft(r);
});

test("with no error in Source code an error in Test code leaves the Run at exit code 0", async (t) => {
  const original = copyProject(t, "project-eslint-test-code");
  writeFileSync(
    join(original, "src", "index.js"),
    "function same(a, b) {\n  return a === b;\n}\n\nmodule.exports = { same };\n",
  );

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "lint.existing",
  ]);

  assert.equal(r.code, 0, `no Gate\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.deepEqual(
    [exec.status, exec.outcome, exec.gate],
    ["completed", "observations_only", 0],
  );
  const f = lintFindingsByRule(s).get("no-var");
  assert.deepEqual([f?.gate, f?.severity], [false, "error"]);
  assert.equal(
    partOf(s, "project_linter").raw_value,
    1,
    "the error in Test code still counts",
  );
  assertNothingLeft(r);
});

test("lint.existing reports a legacy ESLint config with ESLint 10 as a project error", async (t) => {
  const original = copyProject(t, "eslint-legacy");

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(r.code, 1, `exit 1 for the project error\n${r.stderr}`);
  const s = lintReport(r);
  const exec = oneExecution(s, "lint.existing");
  assert.equal(exec.status, "completed");
  assert.equal(exec.gate, 1);
  const f = lintFindingsByRule(s).get("eslint-legacy-config");
  assert.ok(f?.gate, JSON.stringify(s.findings));
  assert.equal(f.locations[0]?.path, ".eslintrc.json");
  assert.ok(
    f.message.includes("ESLint 10.") && f.message.includes("eslint.config"),
    f.message,
  );
  assertNothingLeft(r);
});

test("lint.existing is not applicable to a package with neither linter", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.deepEqual(
    executionsOf(lintReport(r), "lint.existing").filter(
      (e) => e.applicability === "applicable",
    ),
    [],
    "clean-mocha has neither ESLint nor Biome",
  );
  assertNothingLeft(r);
});

test("lint.existing does not apply to ESLint without any configuration and fires no Gate", async (t) => {
  const original = copyProject(t, "eslint-no-config");

  const r = await realRun(t, ["test", original, "--only", "lint.existing"]);

  assert.equal(
    r.code,
    0,
    `the project has no linter setup that could fail\n${r.stderr}`,
  );
  assert.notEqual(r.reportDir, "");
  const s = lintReport(r);
  const execs = executionsOf(s, "lint.existing");
  assert.ok(execs.length > 0, "the Report holds no lint.existing execution");
  for (const e of execs) {
    assert.equal(e.applicability, "not_applicable");
    assert.equal(e.gate, 0);
  }
  assert.deepEqual(findingsOf(s, "lint.existing"), []);
  assertNothingLeft(r);
});
