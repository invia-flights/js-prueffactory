import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runProject, selection, tempDir } from "./engine.testutil.ts";

// Whole Runs without a Docker daemon (Go: selection_test.go, fast_test.go).
// The secret scan wants to run as a prerequisite of redaction; without
// Docker the Preparation phase fails and the Report says so.

const demo = {
  "package.json": `{"name":"demo"}`,
  "index.js": "module.exports = 1;\n",
};

test("deselected Checks are reported and do not change the exit code", async (t) => {
  // Go: TestDeselectedChecksAreReportedAndDoNotChangeTheExitCode
  const sel = selection({
    only: ["some.other"],
    exclude: ["syntax"],
    deselected: ["syntax.parse"],
  });
  const { exitCode, report, reportDir } = await runProject(t, demo, sel);
  assert.equal(
    exitCode,
    0,
    "a deselected Check must never change the exit code",
  );

  const syntax = report.checks.find((e) => e.check_id === "syntax.parse");
  assert.ok(syntax !== undefined);
  assert.equal(syntax.selected, false);
  assert.equal(syntax.status, "not_started");
  assert.equal(syntax.applicability, "applicable");
  assert.equal(syntax.reason_code, "deselected");

  const s = report.selection;
  assert.equal(s.is_standard_scope, false);
  assert.deepEqual(s.only, ["some.other"]);
  assert.deepEqual(s.exclude, ["syntax"]);
  assert.deepEqual(s.deselected_checks, ["syntax.parse"]);
  assert.deepEqual(s.effective_checks, []);
  assert.deepEqual(s.prerequisites_run, ["security.secrets"]);

  const red = report.report_completeness.redaction;
  assert.equal(red?.applied, false);
  assert.match(String(red.reason), /did not complete/);

  assert.deepEqual(
    [
      report.summary.scope_completeness?.required,
      report.summary.scope_completeness?.completed,
    ],
    [0, 0],
  );
  assert.ok(Number(report.summary.standard_completeness?.required) >= 1);
  assert.equal(report.summary.standard_completeness?.completed, 0);

  const md = readFileSync(join(reportDir, "report.md"), "utf8");
  assert.ok(md.includes("deselected"));
  assert.ok(md.includes("Scope completeness: 0 of 0"));
});

test("--fast is recorded and named as the reason of the Checks it left out", async (t) => {
  // Go: TestFastIsRecordedAndNamedAsTheReasonOfTheChecksItLeftOut
  const sel = selection({
    exclude: ["package.manifest"],
    deselected: ["package.manifest", "syntax.parse"],
    deselectedByFast: ["syntax.parse"],
    fast: true,
  });
  const { report } = await runProject(t, demo, sel, {
    formats: { json: true, markdown: false },
    budgetSource: "fast_default",
  });
  assert.equal(report.selection.fast, true);
  assert.equal(report.schema_version, "0.4.0");
  assert.deepEqual(report.profiles, {
    ...(report.profiles as object),
    catalog_version: "milestone-2",
    execution_profile: "execution-v1",
  });
  assert.equal(report.run.budget_source, "fast_default");
  const code = (id: string) =>
    report.checks.find((e) => e.check_id === id && !e.selected)?.reason_code;
  assert.equal(code("syntax.parse"), "deselected_by_fast");
  assert.equal(code("package.manifest"), "deselected");
});

test("a Run checks the Original at the end, records it unchanged and removes its Snapshot copy", async (t) => {
  const sel = selection({ effective: ["package.manifest"], deselected: [] });
  const tmp = tempDir(t);
  const { exitCode, report, log } = await runProject(t, demo, sel, {
    tempDir: tmp,
  });
  assert.equal(exitCode, 0, "a missing lockfile is a warning");
  assert.deepEqual(
    report.findings.map((f) => f.rule_id),
    ["lockfile-missing"],
  );
  const source = report.source as {
    original_unchanged: boolean;
    changed_paths: string[];
  };
  assert.equal(source.original_unchanged, true);
  assert.deepEqual(source.changed_paths, []);
  assert.match(log, /the Original is unchanged/);
  assert.deepEqual(
    readdirSync(tmp),
    [],
    "the host-side Snapshot copy was removed",
  );
  const manifest = report.checks.find(
    (e) =>
      e.check_id === "package.manifest" && e.applicability === "applicable",
  );
  assert.equal(manifest?.status, "completed");
});
