// Running the executions (Go: schedule.go).
import { Input, type Result } from "../checks/input.ts";
import { projectWithProbedTestFiles } from "../checks/test_files_probe.ts";
import { withDeadline, withTimeout } from "../gocompat/context.ts";
import { type Duration, durationString } from "../gocompat/time.ts";
import type { Evidence, ExecStatus } from "../resultset/types.ts";
import {
  StatusBudgetExhausted,
  StatusCancelled,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
} from "../resultset/types.ts";
import {
  endReason,
  isTestSuite,
  parallelism,
  reserveStart,
  timeLimit,
} from "./budget.ts";
import { prepare } from "./docker.ts";
import type { RunState } from "./engine.ts";
import {
  deselectedResult,
  type ExecResult,
  execResult,
  newExec,
  stopped,
  strPtr,
} from "./execution.ts";
import { type Planned, runnable } from "./plan.ts";
import { type Job, schedule } from "./pool.ts";
import {
  blockedByPrerequisite,
  reasonPrerequisiteFailedProject,
} from "./prerequisites.ts";
import { takeSecretScan } from "./redaction.ts";
import { recordNPM, recordTools } from "./tools.ts";
import { errorMessage } from "../gocompat/errors.ts";

/** usesDocker says whether an execution starts a container and so needs the Preparation phase. */
export function usesDocker(p: Planned): boolean {
  return (p.check.images?.(p.context) ?? []).length > 0;
}

/**
 * executeAll performs every planned execution and records the results in
 * planned order, whichever worker finishes first.
 *
 * Executions that need no container (native Checks) start at once, while
 * the Preparation phase runs. The rest wait for it. At most parallelism(...)
 * executions run at a time, test suites and their installs first (see
 * orderJobs), then the others in Catalog order. Everything runs inside the
 * Budget minus the reserve for the Report.
 */
export async function executeAll(
  r: RunState,
  signal: AbortSignal,
): Promise<void> {
  const budget = withDeadline(signal, reserveStart(r.cfg.start, r.cfg.budget));
  try {
    const results = new Array<ExecResult>(r.planned.length);
    const jobs: Job[] = [];
    r.planned.forEach((p, i) => {
      if (!runnable(p)) {
        if (p.deselected) {
          results[i] = deselectedResult(p);
          return;
        }
        const e = newExec(p);
        e.reason_code = "not_applicable";
        e.reason = strPtr(p.reason);
        results[i] = execResult(p, e);
        return;
      }
      jobs.push({ index: i, p, needsDocker: usesDocker(p), after: [] });
    });
    orderJobs(jobs);

    let ready: Promise<void> | null = null;
    let prepareErr: unknown = null;
    if (jobs.some((j) => j.needsDocker)) {
      ready = prepare(r, budget.signal).then(
        () => undefined,
        (err: unknown) => {
          prepareErr = err;
        },
      );
    }

    const workers =
      r.cfg.dockerInfo === null ? 1 : parallelism(r.cfg.dockerInfo.cpus);
    linkAfter(jobs);
    const start = async (j: Job): Promise<ExecResult> => {
      let res = blockedByPrerequisite(r, j.p);
      if (res !== null) {
        r.log.print(
          `not running ${j.p.entry.id} in ${j.p.context.id}: ${res.exec.reason ?? ""}`,
        );
      } else if (j.needsDocker && prepareErr !== null) {
        res = failedPreparation(r, signal, budget.signal, j.p, prepareErr);
      } else {
        res = await execute(r, signal, budget.signal, j.p, j.needsDocker);
      }
      r.finish(j.p, res);
      return res;
    };
    const skip = (j: Job): ExecResult => {
      const res = notStarted(r, signal, j.p);
      r.finish(j.p, res);
      return res;
    };
    const out = await schedule(
      budget.signal,
      jobs,
      workers,
      ready,
      start,
      skip,
    );
    jobs.forEach((j, i) => {
      const res = out[i];
      if (res !== undefined) {
        results[j.index] = res;
      }
    });
    await ready;

    for (const res of results) {
      const taken = takeSecretScan(r, res);
      r.results.push(taken);
      if (taken.exec.status === StatusCancelled) {
        r.cancelled = true;
      }
    }
  } finally {
    budget.cancel();
  }
}

/**
 * linkAfter sets what each job waits for: the executions it needs, the
 * installs it waits for and the executions it follows, as far as they are
 * jobs.
 */
export function linkAfter(jobs: Job[]): void {
  const position = new Map<Planned, number>();
  jobs.forEach((j, i) => position.set(j.p, i));
  for (const j of jobs) {
    const p = j.p;
    for (const q of [...p.needs, ...p.waits, ...p.follows, ...p.orderedAfter]) {
      const at = position.get(q);
      if (at !== undefined) {
        j.after.push(at);
      }
    }
  }
}

/**
 * orderJobs puts the jobs in the order the scheduler offers them to free
 * workers: executions that need no container first, then the installs that
 * test suites wait for, so that a suite starts as soon as its install is
 * done, then the test suites, which take the longest, then the rest. Within
 * each group the planner's Catalog order stays.
 */
export function orderJobs(jobs: Job[]): void {
  const neededBySuite = new Set<Planned>();
  for (const j of jobs) {
    if (isTestSuite(j.p.entry.id)) {
      for (const q of j.p.needs) {
        neededBySuite.add(q);
      }
    }
  }
  const rank = (j: Job): number => {
    if (!j.needsDocker) return 0;
    if (neededBySuite.has(j.p)) return 1;
    if (isTestSuite(j.p.entry.id)) return 2;
    return 3;
  };
  // Array.prototype.sort is stable, as Go's sort.SliceStable.
  jobs.sort((a, b) => rank(a) - rank(b));
}

/** reasonFor gives the reason code and text of a status that ended an execution. */
export function reasonFor(
  status: ExecStatus,
  limit: Duration,
): [string, string] {
  switch (status) {
    case StatusCancelled:
      return ["cancelled", "the Run was cancelled"];
    case StatusBudgetExhausted:
      return ["budget_exhausted", "the Budget ran out"];
    default:
      return [
        "timeout",
        `the Check ran into its time limit of ${durationString(limit)}`,
      ];
  }
}

/**
 * notStarted reports an execution the Budget or a cancellation kept from
 * starting. It is never reported as passed.
 */
export function notStarted(
  r: RunState,
  signal: AbortSignal,
  p: Planned,
): ExecResult {
  let status: ExecStatus = StatusBudgetExhausted;
  let reason = "the Budget ran out before this Check started";
  if (signal.aborted) {
    status = StatusCancelled;
    reason = "the Run was cancelled before this Check started";
  }
  r.log.print(`not started ${p.entry.id} in ${p.context.id}: ${status}`);
  const [code] = reasonFor(status, 0n);
  return stopped(p, status, code, reason);
}

/**
 * failedPreparation reports an execution that could not start because the
 * Preparation phase failed or was cut short.
 */
function failedPreparation(
  r: RunState,
  signal: AbortSignal,
  budget: AbortSignal,
  p: Planned,
  err: unknown,
): ExecResult {
  if (endReason(signal, budget, budget) !== null) {
    return notStarted(r, signal, p);
  }
  r.log.print(`preparation failed: ${errorMessage(err)}`);
  return stopped(
    p,
    StatusInfrastructureError,
    "docker_setup_failed",
    errorMessage(err),
  );
}

/**
 * execute runs one Check in one Context, inside the Budget and its own time
 * limit.
 */
export async function execute(
  r: RunState,
  signal: AbortSignal,
  budget: AbortSignal,
  p: Planned,
  docker: boolean,
): Promise<ExecResult> {
  r.log.print(`running ${p.entry.id} in ${p.context.id} (${p.context.path})`);
  const started = new Date();
  const limit = timeLimit(p.entry.id);
  const own = withTimeout(budget, limit);
  let res: Result;
  try {
    res = await safeRun(r, own.signal, p, docker);
    if (
      res.status !== StatusCompleted &&
      !(res.keepsStatus === true && !signal.aborted)
    ) {
      const status = endReason(signal, budget, own.signal);
      if (status !== null) {
        res.status = status;
        [res.reasonCode, res.reason] = reasonFor(status, limit);
      }
    }
  } finally {
    own.cancel();
  }

  const e = newExec(p);
  e.status = res.status;
  e.reason_code = strPtr(res.reasonCode);
  e.reason = strPtr(res.reason);
  e.started_at = started;
  e.duration_ms = Date.now() - started.getTime();
  e.tool = res.tool ?? null;
  e.command = res.command ?? [];
  recordTools(p.context, res.toolRefs ?? []);
  recordNPM(p.context, res.npmVersion ?? "");

  const out = execResult(p, e, {
    limitations: res.limitations ?? [],
    inventory: res.inventory ?? null,
    contextTools: res.contextTools ?? [],
    redact: res.redact ?? [],
    services: res.services ?? [],
    registryDate: res.registryDataDate ?? null,
  });
  // A Check may key its artifacts and let Evidence refer to them by that key.
  const artifactIDs = new Map<string, string>();
  (res.artifacts ?? []).forEach((a0, i) => {
    const key = a0.id;
    const a = { ...a0, id: `${p.key}-a${String(i + 1)}`, check_id: p.entry.id };
    if (key !== "") {
      artifactIDs.set(key, a.id);
    }
    out.artifacts.push(a);
    out.exec.artifact_ids.push(a.id);
  });
  const findings = res.findings ?? [];
  findings.forEach((f0, i) => {
    if (f0.gate) {
      if (out.gates === 0) {
        out.failure = f0.title + ": " + f0.message;
      }
      out.gates++;
    }
    if (p.deselected) {
      // A prerequisite that ran without being selected reports no Findings
      // and fires no Gates. Its failure shows in its reason.
      return;
    }
    out.findings.push({
      ...f0,
      id: `${p.key}-f${String(i + 1)}`,
      execution_id: p.key,
      check_id: p.entry.id,
      context_id: p.context.id,
      evidence: linkEvidence(f0.evidence, artifactIDs),
    });
  });
  if (p.deselected && out.gates > 0) {
    out.exec.reason_code = reasonPrerequisiteFailedProject;
    out.exec.reason =
      "failed because of the project, as a prerequisite that was not selected, so it reports no Findings: " +
      out.failure;
  }
  if (!p.deselected) {
    for (const c of res.testCases ?? []) {
      out.testCases.push({
        ...c.testCase,
        execution_id: p.key,
        finding_ids: c.findings.map((i) => `${p.key}-f${String(i + 1)}`),
      });
    }
    (res.metrics ?? []).forEach((m, i) => {
      out.metrics.push({
        ...m,
        id: `${p.key}-m${String(i + 1)}`,
        check_id: p.entry.id,
        context_id: p.context.id,
      });
    });
  }
  r.log.print(
    `finished ${p.entry.id} in ${p.context.id}: ${res.status}, ${String(findings.length)} finding(s)`,
  );
  return out;
}

/**
 * linkEvidence replaces the artifact keys of a Finding's Evidence by the IDs
 * the artifacts got. A key that names no artifact of the Check is dropped,
 * because a link to nothing would make the Report invalid.
 */
export function linkEvidence(
  evidence: Evidence[],
  ids: ReadonlyMap<string, string>,
): Evidence[] {
  if (evidence.every((ev) => ev.artifact_id === null)) {
    return evidence;
  }
  return evidence.map((ev) =>
    ev.artifact_id === null
      ? ev
      : { ...ev, artifact_id: ids.get(ev.artifact_id) ?? null },
  );
}

/**
 * safeRun calls the Check and turns an exception into a tool_error, so one
 * broken Check never takes the Run down.
 */
async function safeRun(
  r: RunState,
  signal: AbortSignal,
  p: Planned,
  docker: boolean,
): Promise<Result> {
  try {
    const proj = r.proj;
    const snap = r.snap;
    if (proj === null || snap === null) {
      throw new Error("the Run has no Snapshot");
    }
    const input = new Input({
      project: proj,
      context: p.context,
      originalPath: r.cfg.original,
      snapshotDir: snap.dir,
      docker: r.cfg.docker,
      snapshotTar: (out) => snap.writeTar(out),
      selection: r.selection,
      shared: r.shared,
      redactText: r.redactText,
    });
    if (p.check.readsFileClasses?.() === true) {
      // The probes this execution waited for have finished. The Project it
      // sees has the files the test runners load as Test code; the one the
      // other Checks read at the same time is never changed.
      [input.project, input.context] = projectWithProbedTestFiles(
        proj,
        p.context,
        r.shared,
        p.waits.map((q) => q.context.id),
      );
    }
    if (docker) {
      // The Preparation phase has finished by now; native Checks run while
      // it is still writing these.
      input.snapshotVolume = r.volume;
      input.network = r.network;
      input.workVolume = r.workVolume;
      input.toolsetVolume = r.toolsetVolume;
      input.toolsetError = r.toolsetErr;
      input.advisoryVolume = r.advisory.volume;
      input.advisoryDate = r.advisory.date;
      input.advisoryWarning = r.advisory.warning;
      input.advisoryError = r.advisory.err;
      input.kubernetesSchemaVolume = r.kubernetesSchemas.volume;
      input.kubernetesSchemaError = r.kubernetesSchemas.err;
    }
    return await p.check.run(signal, input);
  } catch (v) {
    const stack = v instanceof Error ? (v.stack ?? "") : "";
    r.log.print(
      `internal error in ${p.entry.id}: ${errorMessage(v)}\n${stack}`,
    );
    return {
      status: StatusToolError,
      reasonCode: "internal_error",
      reason: `the Check panicked: ${errorMessage(v)}`,
    };
  }
}
