// Prerequisites in whole Runs without a Docker daemon (Go:
// prerequisites_test.go): a project whose packages cannot be installed
// never starts a container.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import "../checks/all.ts";
import { catalog } from "../checks/catalog.ts";
import { resolve } from "../checks/selection.ts";
import {
  type ReportExec,
  type ReportJSON,
  runProject,
} from "./engine.testutil.ts";

const pnpmProject = {
  "package.json": `{"name":"demo","devDependencies":{"mocha":"^10.0.0"}}`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
};

function runPnpmProject(t: TestContext, ...only: string[]) {
  return runProject(t, pnpmProject, resolve(catalog(), only, []));
}

function executionOf(
  report: ReportJSON,
  check: string,
): ReportExec & Record<string, unknown> {
  const e = report.checks.find(
    (x) => x.check_id === check && x.applicability !== "not_applicable",
  );
  assert.ok(e, `no applicable execution of ${check}`);
  return e as ReportExec & Record<string, unknown>;
}

/**
 * prerequisitesOf is prerequisites_run without the secret scan, which every
 * Run performs for the sake of redaction whatever is selected.
 */
function prerequisitesOf(report: ReportJSON): string[] {
  return (report.selection.prerequisites_run as string[]).filter(
    (id) => id !== "security.secrets",
  );
}

test("only deps.tree runs the install as a prerequisite", async (t) => {
  const { exitCode, report } = await runPnpmProject(t, "deps.tree");

  const install = executionOf(report, "package.install");
  assert.equal(install.selected, false, "package.install was not selected");
  assert.equal(
    install.status,
    "unsupported",
    "package.install ran as a prerequisite; a pnpm project is unsupported",
  );
  assert.deepEqual(prerequisitesOf(report), ["package.install"]);
  assert.deepEqual(
    report.selection.effective_checks,
    ["deps.tree"],
    "a prerequisite is not part of the Selection",
  );

  const tree = executionOf(report, "deps.tree");
  assert.equal(tree.selected, true);
  assert.equal(tree.status, "unsupported");
  assert.equal(tree.reason_code, "package_manager_unsupported");
  assert.notEqual(tree.reason, null);
  // The prerequisite reports no Findings of its own and no Gates.
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.gates, 0);
  // Only deps.tree is in the Selection, and it did not complete.
  assert.equal(exitCode, 2);
});

test("a selected install is no prerequisite run without Selection", async (t) => {
  const { report } = await runPnpmProject(t, "package.install");

  assert.deepEqual(prerequisitesOf(report), []);
  const install = executionOf(report, "package.install");
  assert.equal(install.selected, true);
  assert.equal(install.status, "unsupported");
  // deps.tree is not selected and nothing selected needs it.
  for (const e of report.checks) {
    if (e.check_id === "deps.tree") {
      assert.equal(e.status, "not_started");
    }
  }
});

test("selecting both runs each once and reports no prerequisite", async (t) => {
  const { report } = await runPnpmProject(t, "package.install,deps.tree");

  assert.deepEqual(prerequisitesOf(report), []);
  assert.equal(executionOf(report, "package.install").selected, true);
});
