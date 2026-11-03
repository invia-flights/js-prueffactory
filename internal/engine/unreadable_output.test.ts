// A tool whose output cannot be read, through the engine and the renderers
// (spec "Trustworthy gates", ticket 04): the Check ends tool_error with the
// reason code tool_output_unreadable, makes no Finding and no Gate, keeps the
// raw output as artifacts that the Report lists with their SHA-256, redacts a
// secret in them, and report.md shows the reason with the artifact's path.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { entry as catalogEntry } from "./engine.testutil.ts";
import { impl } from "../checks/checks.testutil.ts";
import { discover } from "../discovery/discovery.ts";
import type { ContainerResult, Driver } from "../docker/driver.ts";
import { md } from "../render/render.testutil.ts";
import { exitCode, ExitIncomplete } from "../resultset/exitcode.ts";
import { finalize } from "../resultset/finalize.ts";
import { newSet } from "../resultset/zero.ts";
import { executeOne, planned, runState, writeTree } from "./engine.testutil.ts";
import { redactSet } from "./redaction.ts";

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

async function unreadableRun(t: TestContext, stdout: string, stderr: string) {
  const r = runState(t, { docker: stubDocker(stdout, stderr) });
  if (r.snap === null) {
    throw new Error("no Snapshot");
  }
  writeTree(r.snap.dir, { Dockerfile: "FROM node:24\n" });
  r.proj = discover(r.snap.dir);
  const context = r.proj.contexts[0];
  assert.ok(context);
  const res = await executeOne(
    r,
    planned({
      entry: catalogEntry("repository.dockerfile"),
      check: impl("repository.dockerfile"),
      context,
    }),
  );
  const s = newSet();
  s.checks.push(res.exec);
  s.findings.push(...res.findings);
  s.artifacts.push(...res.artifacts);
  s.contexts = [context];
  r.redactor.addFrom("gitleaks", secret);
  redactSet(r, s);
  finalize(s);
  return s;
}

test("unreadable output ends the Check tool_error with no Finding and exit code 2, and report.md names the artifact", async (t) => {
  const s = await unreadableRun(
    t,
    `{"not":"hadolint's array"}`,
    "warning: nothing readable here",
  );

  const e = s.checks[0];
  assert.ok(e);
  assert.deepEqual(
    [e.status, e.reason_code],
    ["tool_error", "tool_output_unreadable"],
  );
  assert.deepEqual(s.findings, []);
  assert.equal(s.summary.gates, 0);
  assert.equal(exitCode(s), ExitIncomplete);

  // The raw output of the call is in the Report with its digest.
  const paths = s.artifacts.map((a) => a.path);
  assert.deepEqual(paths, [
    "artifacts/repository.dockerfile/C-0001/hadolint-1.stderr.txt",
    "artifacts/repository.dockerfile/C-0001/hadolint-1.stdout.txt",
  ]);
  for (const a of s.artifacts) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, a.path);
    assert.ok(e.artifact_ids.includes(a.id), a.path);
  }

  // report.md shows the reason with the artifact's path.
  const text = md(s);
  assert.ok(text.includes("tool_output_unreadable"), text);
  for (const p of paths) {
    assert.ok(text.includes(p), `${p} is not in report.md`);
  }
});

test("a secret in the raw output of a tool is redacted in the artifact", async (t) => {
  const s = await unreadableRun(
    t,
    `[{"code":"DL3006","level":"warning","message":"${secret}"}`,
    `hadolint: ${secret}`,
  );
  assert.equal(s.artifacts.length, 2);
  for (const a of s.artifacts) {
    const content = Buffer.from(a.content ?? []).toString();
    assert.ok(a.redacted, a.path);
    assert.ok(content.includes("[REDACTED]"), content);
    assert.ok(!content.includes("ghp_"), `${a.path} leaks the secret`);
  }
  assert.ok(!md(s).includes("ghp_"));
});
