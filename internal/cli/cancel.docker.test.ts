import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { formatRFC3339 } from "../gocompat/json.ts";

import { withInterrupts } from "./interrupt.ts";
import {
  assertNoRunResources,
  assertNothingLeft,
  copyProject,
  forceRemoveRun,
  realRun,
  runIDFromProgress,
  treeFingerprint,
} from "./realrun.testutil.ts";

// Ctrl-C and the Budget through the entry point with a real Docker daemon
// (Go: cancel_docker_test.go, budget_docker_test.go). The Runs use the default
// Selection; the interrupt comes the moment the first Check starts.

function interruptAt(n: number) {
  const i = withInterrupts();
  let sent = false;
  return {
    signal: i.signal,
    onStderrLine: (line: string) => {
      if (!sent && line.includes("running syntax.parse")) {
        sent = true;
        for (let k = 0; k < n; k++) i.interrupt();
      }
    },
    stop: () => {
      i.stop();
    },
  };
}

test("Ctrl-C cancels, cleans up and still writes a cancelled Report", async (t) => {
  // Go: TestCtrlCCancelsCleansUpAndStillWritesACancelledReport
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);
  const hook = interruptAt(1);
  t.after(hook.stop);

  const r = await realRun(t, ["test", original], hook);

  assert.equal(r.code, 130, r.stderr);
  assert.notEqual(r.reportDir, "", "no Report folder was printed");
  assert.equal(r.report.run.status, "cancelled");
  assert.equal(r.report.run.exit_code, 130);
  assert.ok(
    r.report.checks.some((c) => c.status === "cancelled"),
    "no Check execution is marked cancelled",
  );
  assert.ok(existsSync(join(r.reportDir, "report.md")));
  assertNothingLeft(r);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assert.ok(r.report.source.original_unchanged);
});

test("a cancelled signal at the entry point is the same as Ctrl-C", async (t) => {
  // Go: TestACancelledContextAtTheEntryPointIsTheSameAsCtrlC
  const original = copyProject(t, "clean-mocha");
  const ctl = new AbortController();
  const r = await realRun(t, ["test", original], {
    signal: ctl.signal,
    onStderrLine: (line) => {
      if (line.includes("running syntax.parse")) ctl.abort();
    },
  });
  assert.equal(r.code, 130, r.stderr);
  assert.equal(r.report.run.status, "cancelled");
  assertNothingLeft(r);
});

test("a second Ctrl-C skips the Report, cleans up and still exits 130", async (t) => {
  // Go: TestASecondCtrlCSkipsTheReportCleansUpAndStillExitsOneThirty
  const original = copyProject(t, "clean-mocha");
  const before = treeFingerprint(original);
  const hook = interruptAt(2);
  t.after(hook.stop);

  const r = await realRun(t, ["test", original], hook);

  assert.equal(r.code, 130, r.stderr);
  assert.equal(r.stdout, "", "no Report was written");
  assert.ok(r.stderr.endsWith("js-prueffactory: interrupted\n"));
  const id = runIDFromProgress(r.stderr);
  t.after(() => {
    forceRemoveRun(id);
  });
  assertNoRunResources(id);
  assert.deepEqual(
    readdirSync(r.tmp),
    [],
    "the host-side Snapshot copy was not removed",
  );
  assert.equal(treeFingerprint(original), before, "the Original changed");
});

test("a tiny Budget leaves every Check budget_exhausted and the Run incomplete", async (t) => {
  // Go: TestATinyBudgetLeavesEveryCheckBudgetExhaustedAndTheRunIncomplete.
  // The last 60 seconds of any Budget are reserved for the Report, so a
  // one-second Budget has no time for any Check.
  const original = copyProject(t, "clean-mocha");
  const r = await realRun(t, ["test", original, "--budget", "1s"]);

  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.report.run.status, "incomplete");
  assert.equal(r.report.run.budget_seconds, 1);
  assert.equal(r.report.run.budget_source, "flag");
  const applicable = r.report.checks.filter(
    (c) => c.applicability !== "not_applicable",
  );
  assert.ok(applicable.length > 0, "the project has no applicable Check");
  for (const c of applicable.filter((x) => x.selected)) {
    assert.equal(c.status, "budget_exhausted", c.check_id);
    assert.notEqual(c.outcome, "passed", c.check_id);
  }
  assertNothingLeft(r);
  assert.ok(r.report.source.original_unchanged);
});

// plantVolume creates a labelled volume that pretends to belong to another Run.
function plantVolume(
  t: TestContext,
  runID: string,
  host: string,
  pid: number,
  deadline: Date,
): string {
  const name = `jspf-${runID}-planted`;
  execFileSync("docker", [
    "volume",
    "create",
    "--label",
    `js-prueffactory.run-id=${runID}`,
    "--label",
    `js-prueffactory.host=${host}`,
    "--label",
    `js-prueffactory.pid=${String(pid)}`,
    "--label",
    `js-prueffactory.deadline=${formatRFC3339(deadline)}`,
    name,
  ]);
  t.after(() => {
    spawnSync("docker", ["volume", "rm", "-f", name]);
  });
  return name;
}

function volumeExists(name: string): boolean {
  return spawnSync("docker", ["volume", "inspect", name]).status === 0;
}

function deadPID(): number {
  const r = spawnSync("true");
  assert.ok(r.pid > 0);
  return r.pid;
}

test("the next Run sweeps up what a dead Run left and spares live Runs", async (t) => {
  // Go: TestTheNextRunSweepsUpWhatADeadRunLeftAndSparesLiveRuns. Other Docker
  // tests may run at the same time, so every run ID is unique.
  const host = hostname();
  const now = new Date();
  const nonce = (now.getTime() % 1e9).toString(36) + process.pid.toString(36);
  const expired = plantVolume(
    t,
    `20250101T000000Z-expired-${nonce}`,
    "elsewhere",
    process.pid,
    new Date(now.getTime() - 60_000),
  );
  const orphan = plantVolume(
    t,
    `20250101T000000Z-orphan-${nonce}`,
    host,
    deadPID(),
    new Date(now.getTime() + 3_600_000),
  );
  const live = plantVolume(
    t,
    `20250101T000000Z-live-${nonce}`,
    host,
    process.pid,
    new Date(now.getTime() + 3_600_000),
  );

  const r = await realRun(t, ["test", copyProject(t, "clean-mocha")]);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    volumeExists(expired),
    false,
    "the volume past its deadline was not removed",
  );
  assert.equal(
    volumeExists(orphan),
    false,
    "the volume of a dead process on this host was not removed",
  );
  assert.equal(
    volumeExists(live),
    true,
    "the volume of a live Run was removed",
  );
});
