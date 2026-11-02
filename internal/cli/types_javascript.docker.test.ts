// Seam A with a real Docker daemon, for types.javascript (Go:
// types_javascript_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  artifactOf,
  findingsOf,
  lintReport,
  oneExecution,
} from "./lint.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

test("types.javascript warns about a JSDoc mismatch and ignores the project's own tsconfig", async (t) => {
  const original = copyProject(t, "types-jsdoc");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "types.javascript"]);

  assert.equal(
    r.code,
    0,
    `type errors are warnings and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");

  const s = lintReport(r);
  const exec = oneExecution(s, "types.javascript");
  assert.equal(exec.status, "completed", r.stderr);
  assert.equal(exec.tool?.name, "tsc");
  assert.equal(exec.tool.version, "7.0.2", "TypeScript 7.0.2");
  const command = exec.command.join(" ");
  assert.ok(command.includes("--pretty false"), command);
  assert.ok(command.includes("-p /jspf/tsconfig.json"), command);

  // The package.install prerequisite ran although it was not selected.
  assert.ok(
    s.selection.prerequisites_run.includes("package.install"),
    JSON.stringify(s.selection),
  );

  // Exactly the planted errors: Node's types (require, process, node:os) come
  // from the toolset because the project has none of its own, and the
  // extensionless require of data/schema.json resolves like it does in Node.
  const got = findingsOf(s, "types.javascript").sort(
    (a, b) =>
      (a.locations[0]?.start?.line ?? 0) - (b.locations[0]?.start?.line ?? 0),
  );
  assert.equal(
    got.length,
    2,
    `findings ${JSON.stringify(got)}, want the JSDoc mismatch and the one missing module`,
  );
  const [f, m] = got;
  assert.ok(f && m);
  assert.equal(f.rule_id, "TS2345");
  assert.ok(!f.gate && f.severity === "warning", JSON.stringify(f));
  assert.equal(f.locations[0]?.path, "src/index.js");
  assert.equal(f.locations[0].start?.line, 14);
  // A module that exists neither as .js nor as .json stays a Finding.
  assert.equal(m.rule_id, "TS2307");
  assert.ok(!m.gate && m.severity === "warning", JSON.stringify(m));
  assert.equal(m.locations[0]?.path, "src/index.js");
  assert.equal(m.locations[0].start?.line, 21);

  // What the JSON filter dropped stays visible: the extensionless require of
  // data/schema.json is counted and listed, and is not a resolution error.
  for (const mt of s.metrics) {
    if (mt.check_id !== "types.javascript" || mt.value === null) {
      continue;
    }
    if (mt.name === "json_modules_dropped") {
      assert.equal(mt.value, 1, "json_modules_dropped");
    }
    if (mt.name === "resolution_errors") {
      assert.equal(mt.value, 1, "resolution_errors: only ./data/missing");
    }
  }
  const list = artifactOf(s, exec, "C-0002-json-modules-dropped.json");
  assert.ok(
    list,
    `no list of dropped JSON requires: ${JSON.stringify(s.artifacts)}`,
  );
  const listed = readFileSync(join(r.reportDir, list.path), "utf8");
  for (const want of [
    '"specifier": "./data/schema"',
    '"path": "src/index.js"',
    '"line": 17',
    '"resolves_to": "src/data/schema.json"',
  ]) {
    assert.ok(listed.includes(want), `${want} not in ${listed}`);
  }

  // The generated config is an artifact of the Report.
  const artifact = artifactOf(s, exec, "C-0002-tsconfig.json");
  assert.ok(artifact, `no tsconfig artifact: ${JSON.stringify(s.artifacts)}`);
  const data = readFileSync(join(r.reportDir, artifact.path), "utf8");
  assert.ok(data.includes('"checkJs": true'), data);
  assert.ok(data.includes("/work/src/index.js"), data);
});

test("a package with a TypeScript source file is checked, not unsupported", async (t) => {
  const original = copyProject(t, "typescript-source");

  const r = await realRun(t, ["test", original, "--only", "types.javascript"]);

  assert.equal(
    r.code,
    0,
    `a TypeScript file no longer leaves the Run incomplete\n${r.stderr}`,
  );
  assertNothingLeft(r);
  const s = lintReport(r);
  const exec = oneExecution(s, "types.javascript");
  assert.equal(exec.status, "completed");
  assert.equal(exec.reason_code, null);
  assert.deepEqual(
    findingsOf(s, "types.javascript"),
    [],
    "the interface in shape.ts is correct",
  );
  const artifact = artifactOf(s, exec, "C-0002-tsconfig.json");
  assert.ok(artifact, `no tsconfig artifact: ${JSON.stringify(s.artifacts)}`);
  const data = readFileSync(join(r.reportDir, artifact.path), "utf8");
  assert.ok(data.includes("/work/src/shape.ts"), data);
  assert.ok(data.includes('"jsx"'), data);
});

test("types.javascript warns in JavaScript and TypeScript files of a mostly JavaScript package", async (t) => {
  const original = copyProject(t, "types-mixed-ts");
  const before = treeFingerprint(original);

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "types.javascript,syntax.parse",
  ]);

  assert.equal(
    r.code,
    0,
    `type errors are warnings and the editor tsconfig is no build step\n${r.stderr}`,
  );
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  const s = lintReport(r);
  // syntax.parse still checks the JavaScript that runs.
  assert.equal(oneExecution(s, "syntax.parse").status, "completed");
  const exec = oneExecution(s, "types.javascript");
  assert.ok(
    exec.status === "completed" && exec.reason_code === null,
    `types.javascript ${JSON.stringify(exec)}, want completed and not unsupported\n${r.stderr}`,
  );

  const got = findingsOf(s, "types.javascript");
  assert.equal(
    got.length,
    2,
    `findings ${JSON.stringify(got)}, want the JSDoc mismatch and the TypeScript error`,
  );
  const byPath = new Map<string, (typeof got)[number]>();
  for (const f of got) {
    assert.ok(
      !f.gate &&
        f.severity === "warning" &&
        f.confidence === "suspected" &&
        f.rule_id !== null,
      `finding ${JSON.stringify(f)}, want a suspected warning without Gate`,
    );
    byPath.set(f.locations[0]?.path ?? "", f);
  }
  const js = byPath.get("src/index.js");
  assert.ok(js);
  assert.equal(js.rule_id, "TS2345");
  assert.equal(js.locations[0]?.start?.line, 12);
  const ts = byPath.get("src/shape.ts");
  assert.ok(ts);
  assert.equal(ts.rule_id, "TS2322");
  assert.equal(ts.locations[0]?.start?.line, 5);
  for (const l of s.limitations) {
    assert.notEqual(
      l.reason_code,
      "project_tsconfig_not_used",
      "none for two plain type errors",
    );
  }
});

test("types.javascript parses tsx files", async (t) => {
  const original = copyProject(t, "types-tsx");

  const r = await realRun(t, ["test", original, "--only", "types.javascript"]);

  assert.equal(r.code, 0, r.stderr);
  const s = lintReport(r);
  assert.equal(
    oneExecution(s, "types.javascript").status,
    "completed",
    r.stderr,
  );
  const got = findingsOf(s, "types.javascript");
  // Only the planted mismatch: the JSX parses and raises no syntax error (TS1xxx).
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0]?.rule_id, "TS2322");
  assert.equal(got[0].locations[0]?.path, "src/view.tsx");
  assert.equal(got[0].locations[0].start?.line, 2);
});

test("TypeScript that needs a build step stays unsupported for types.javascript and syntax.parse", async (t) => {
  const original = copyProject(t, "typescript-build-step");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "types.javascript,syntax.parse",
  ]);

  assert.equal(
    r.code,
    2,
    `selected Checks that are unsupported leave the Run incomplete\n${r.stderr}`,
  );
  assertNothingLeft(r);
  const s = lintReport(r);
  for (const id of ["types.javascript", "syntax.parse"]) {
    const exec = oneExecution(s, id);
    assert.ok(
      exec.status === "unsupported" &&
        exec.reason_code === "build_step_required" &&
        exec.reason?.includes("outDir") === true,
      `${id} ${JSON.stringify(exec)}, want unsupported with the build step and its sign named`,
    );
  }
  assert.deepEqual(findingsOf(s, "types.javascript"), []);
});

test("types.javascript names the missing project tsconfig when path aliases flood the findings", async (t) => {
  const original = copyProject(t, "types-path-aliases");

  const r = await realRun(t, ["test", original, "--only", "types.javascript"]);

  assert.equal(r.code, 0, r.stderr);
  const s = lintReport(r);
  assert.equal(
    oneExecution(s, "types.javascript").status,
    "completed",
    r.stderr,
  );
  const got = findingsOf(s, "types.javascript");
  assert.equal(
    got.length,
    6,
    `findings ${JSON.stringify(got)}, want six unresolved imports`,
  );
  for (const f of got) {
    assert.ok(
      f.rule_id === "TS2307" && f.severity === "warning" && !f.gate,
      `finding ${JSON.stringify(f)}, want a TS2307 warning without Gate`,
    );
  }
  const limitation = s.limitations.find(
    (l) => l.reason_code === "project_tsconfig_not_used",
  );
  assert.ok(
    limitation?.check_id === "types.javascript" &&
      limitation.message.includes("6 of 6") &&
      limitation.message.includes("tsconfig"),
    `limitations ${JSON.stringify(s.limitations)}, want one that names the missing project tsconfig`,
  );
  const metric = s.metrics.find(
    (m) => m.check_id === "types.javascript" && m.name === "resolution_errors",
  );
  assert.equal(metric?.value, 6, "resolution_errors");
});
