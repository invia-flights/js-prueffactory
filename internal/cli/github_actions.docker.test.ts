// repository.github-actions end to end (Go: github_actions_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  executionOf,
  findingsOf,
  fullReport,
  errorsByPath,
} from "./repository.testutil.ts";
import { writeFiles } from "../testkit/fs.testutil.ts";

const id = "repository.github-actions";

test("a workflow with an actionlint error is an error without a Gate, and zizmor and ShellCheck give warnings", async (t) => {
  const original = copyProject(t, "ci-files");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", id]);

  const s = fullReport(r);
  const e = executionOf(s, id);
  assert.equal(r.code, 0, `reason: ${e.reason ?? ""}\n${r.stderr}`);
  assert.deepEqual(
    [e.status, e.outcome, e.context_id, e.gate],
    ["completed", "observations_only", "C-0001", 0],
    e.reason ?? "",
  );
  assert.equal(e.tool?.name, "actionlint");
  assert.equal(e.tool.version, "1.7.12");
  const tools: string[] = [];
  for (const c of s.contexts) {
    if (c.id !== "C-0001") continue;
    for (const tool of c.tools) {
      assert.ok(
        tool.digest?.startsWith("sha256:"),
        `${tool.name} has no image digest`,
      );
      tools.push(`${tool.name} ${tool.version}`);
    }
  }
  assert.ok(tools.includes("actionlint 1.7.12"), tools.join(","));
  assert.ok(tools.includes("zizmor 1.31.1"), tools.join(","));

  const byRule = new Map(findingsOf(s, id).map((f) => [f.rule_id ?? "", f]));
  const needs = byRule.get("actionlint.job-needs");
  assert.ok(needs);
  assert.equal(needs.gate, false);
  assert.equal(needs.severity, "error");
  assert.equal(needs.locations[0]?.path, ".github/workflows/ci.yml");
  assert.equal(needs.evidence[0]?.trust, "untrusted_data");
  assert.ok(needs.evidence[0].text.includes("biuld"));
  assert.ok(!(needs.title + needs.message).includes("biuld"));

  // ShellCheck's SC2086 comes through actionlint as a warning.
  const shell = byRule.get("actionlint.shellcheck");
  assert.equal(shell?.gate, false);
  assert.equal(shell.severity, "warning");

  // zizmor: the unpinned action is a warning with confidence likely.
  const unpinned = byRule.get("zizmor.unpinned-uses");
  assert.equal(unpinned?.gate, false);
  assert.equal(unpinned.severity, "warning");
  assert.equal(unpinned.confidence, "likely");
  for (const f of findingsOf(s, id)) {
    if (f.rule_id?.startsWith("zizmor.") === true) {
      assert.equal(f.gate, false, `zizmor Finding ${f.rule_id} is a Gate`);
    }
  }
  assert.equal(s.summary.gates, 0);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("workflows that are not YAML are errors without a Gate, and zizmor having nothing to audit is no failure", async (t) => {
  const original = copyProject(t, "ci-files");
  // Replace the workflow with one that no parser reads.
  writeFiles(original, {
    ".github/workflows/ci.yml": "name: broken\non: [push\njobs:\n  a: [\n",
  });

  const r = await realRun(t, ["test", original, "--only", id]);

  const s = fullReport(r);
  const e = executionOf(s, id);
  assert.deepEqual([e.status, e.gate], ["completed", 0], e.reason ?? "");
  assert.equal(
    errorsByPath(s, id).get(".github/workflows/ci.yml")?.rule_id,
    "actionlint.syntax-check",
  );
});

// The project's own configuration of the two tools must not be able to
// switch off the rules that audit its workflows.
test("the project's own tool configuration cannot switch off the errors or the warnings", async (t) => {
  const original = copyProject(t, "ci-files");
  writeFiles(original, {
    ".github/actionlint.yaml":
      "paths:\n  .github/workflows/**/*.yml:\n    ignore:\n      - 'does not exist'\n",
    ".github/zizmor.yml": "rules:\n  unpinned-uses:\n    disable: true\n",
  });

  const r = await realRun(t, ["test", original, "--only", id]);

  const s = fullReport(r);
  assert.equal(executionOf(s, id).gate, 0);
  assert.ok(
    findingsOf(s, id).some((f) => f.severity === "error"),
    "the actionlint error is still reported",
  );
  assert.ok(
    findingsOf(s, id).some((f) => f.rule_id === "zizmor.unpinned-uses"),
    "zizmor.unpinned-uses is gone: the project's zizmor.yml was read",
  );
});

test("the Benchmark has a GitHub Actions part", async (t) => {
  const original = copyProject(t, "ci-files");

  const r = await realRun(t, ["benchmark", original, "--only", id]);

  const part = fullReport(r)
    .benchmark?.areas.flatMap((a) => a.parts)
    .find((p) => p.id === "github_actions");
  assert.equal(part?.state, "measured", JSON.stringify(part));
  assert.ok((part.raw_value ?? 0) >= 2);
  assert.ok((part.n_eff ?? 0) > 0);
});
