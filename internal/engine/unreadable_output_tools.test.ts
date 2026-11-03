// The Checks that share one tool run, through the engine (spec "Trustworthy
// gates", ticket 05): when the combined ESLint run printed something that
// cannot be read, every Check that reads it ends tool_error with
// tool_output_unreadable, each keeps the raw output as artifacts of its own,
// the Report has no Finding and no Gate, and a secret in the output is
// redacted.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { impl } from "../checks/checks.testutil.ts";
import { discover } from "../discovery/discovery.ts";
import type { ContainerResult, Driver } from "../docker/driver.ts";
import { md } from "../render/render.testutil.ts";
import { exitCode, ExitIncomplete } from "../resultset/exitcode.ts";
import { finalize } from "../resultset/finalize.ts";
import { newSet } from "../resultset/zero.ts";
import {
  entry as catalogEntry,
  planned,
  runState,
  writeTree,
} from "./engine.testutil.ts";
import { redactSet } from "./redaction.ts";
import { execute } from "./schedule.ts";

// Made up, like every secret of this repository.
const secret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA";

function stubDocker(stdout: string, stderr: string): Driver {
  const result: ContainerResult = {
    exitCode: 0,
    oomKilled: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    stoppedAfterGrace: false,
  };
  return { runContainer: () => Promise.resolve(result) } as unknown as Driver;
}

const checks = ["lint.correctness", "quality.metrics"];

async function sharedRun(t: TestContext, stdout: string, stderr: string) {
  const r = runState(t, { docker: stubDocker(stdout, stderr) });
  if (r.snap === null) {
    throw new Error("no Snapshot");
  }
  r.toolsetVolume = "jspf-toolset";
  writeTree(r.snap.dir, {
    "package.json": '{"name":"x","version":"1.0.0"}',
    "index.js": "module.exports = 1;\n",
  });
  r.proj = discover(r.snap.dir);
  const context = r.proj.contexts.find((c) => c.package !== null);
  assert.ok(context);
  const s = newSet();
  s.contexts = [context];
  for (const id of checks) {
    // The Docker step has finished, so the Check sees the Run's volumes.
    const res = await execute(
      r,
      new AbortController().signal,
      new AbortController().signal,
      planned({
        key: "k-" + id,
        entry: catalogEntry(id),
        check: impl(id),
        context,
      }),
      true,
    );
    s.checks.push(res.exec);
    s.findings.push(...res.findings);
    s.artifacts.push(...res.artifacts);
  }
  r.redactor.addFrom("gitleaks", secret);
  redactSet(r, s);
  finalize(s);
  return s;
}

test("an unreadable answer of the combined ESLint run ends every Check that reads it tool_error, each with raw output of its own", async (t) => {
  const s = await sharedRun(t, `{"not":"the helper's document"}`, "warning");

  assert.deepEqual(
    s.checks.map((e) => [e.check_id, e.status, e.reason_code]),
    checks.map((id) => [id, "tool_error", "tool_output_unreadable"]),
  );
  assert.deepEqual(s.findings, []);
  assert.equal(s.summary.gates, 0);
  assert.equal(exitCode(s), ExitIncomplete);

  const paths = s.artifacts.map((a) => a.path);
  assert.equal(new Set(paths).size, paths.length, "no path is written twice");
  assert.deepEqual(paths, [
    "artifacts/lint.correctness/C-0002/eslint.stderr.txt",
    "artifacts/lint.correctness/C-0002/eslint.stdout.txt",
    "artifacts/quality.metrics/C-0002/eslint.stderr.txt",
    "artifacts/quality.metrics/C-0002/eslint.stdout.txt",
  ]);
  const text = md(s);
  for (const e of s.checks) {
    const own = s.artifacts.filter((a) => e.artifact_ids.includes(a.id));
    assert.equal(own.length, 2, e.check_id);
    for (const a of own) {
      assert.ok(a.path.includes(e.check_id), a.path);
      assert.match(a.sha256, /^[0-9a-f]{64}$/, a.path);
      assert.ok(text.includes(a.path), `${a.path} is not in report.md`);
    }
  }
});

test("a secret in the raw output of the combined ESLint run is redacted in every artifact", async (t) => {
  const s = await sharedRun(
    t,
    `{"results":[{"message":"${secret}"}`,
    `eslint: ${secret}`,
  );
  assert.equal(s.artifacts.length, 4);
  for (const a of s.artifacts) {
    const content = Buffer.from(a.content ?? []).toString();
    assert.ok(a.redacted, a.path);
    assert.ok(content.includes("[REDACTED]"), content);
    assert.ok(!content.includes("ghp_"), `${a.path} leaks the secret`);
  }
  assert.ok(!md(s).includes("ghp_"));
});
