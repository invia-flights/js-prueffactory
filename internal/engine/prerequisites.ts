// Prerequisites (Go: prerequisites.go). A Check with prerequisites needs
// other Checks of the same Context, such as deps.tree after package.install.
// The plan links them (Planned.needs) and marks the ones the Selection left
// out as prerequisites, so they run anyway. The scheduler starts a dependent
// after its prerequisites finished (Job.after), and the engine decides, from
// how they finished, whether the dependent can run at all.
import { implementedIDs } from "../checks/catalog.ts";
import { hasTestFileProbe } from "../checks/test_files_probe.ts";
import type { Context } from "../discovery/discovery.ts";
import {
  NotApplicable,
  StatusBlocked,
  StatusBudgetExhausted,
  StatusCancelled,
  StatusCompleted,
  StatusInfrastructureError,
  StatusUnsupported,
} from "../resultset/types.ts";
import type { RunState } from "./engine.ts";
import { type ExecResult, stopped } from "./execution.ts";
import { type Planned, runnable } from "./plan.ts";

// Reason codes of a dependent that did not run because of a prerequisite. A
// failure the project caused has its own code, so the Benchmark can tell it
// from one the Run caused. A Run-caused failure keeps the prerequisite's own
// code when it has a specific one, such as missing_registry_credentials.
export const reasonPrerequisiteFailedProject = "prerequisite_failed_project";
export const reasonPrerequisiteFailedRun = "prerequisite_failed_run";
export const reasonPrerequisiteNotRun = "prerequisite_not_run";

/**
 * resolvePrerequisites links every execution to the executions it needs and
 * marks deselected ones that a runnable execution needs as prerequisites. A
 * prerequisite may need prerequisites itself, so it repeats until nothing
 * changes.
 */
export function resolvePrerequisites(all: Planned[]): void {
  const link = (
    p: Planned,
    ids: string[] | undefined,
    into: Planned[],
  ): void => {
    for (const id of ids ?? []) {
      const q = findPlanned(all, id, p.context);
      if (q !== undefined && q !== p) {
        into.push(q);
      }
    }
  };
  for (const p of all) {
    link(p, p.check.prerequisites?.(p.context), p.needs);
    link(p, p.check.runsAfter?.(p.context), p.follows);
    link(p, p.check.orderedAfter?.(p.context), p.orderedAfter);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all) {
      if (!runnable(p)) {
        continue;
      }
      for (const q of [...p.needs, ...p.waits, ...p.follows]) {
        if (
          q.deselected &&
          !q.prerequisite &&
          q.applicability !== NotApplicable
        ) {
          q.prerequisite = true;
          changed = true;
        }
      }
    }
  }
}

/** packageInstallCheck is the Check whose run ends with the test file probe. */
const packageInstallCheck = "package.install";

/**
 * resolveProbeWaits links every Check that reads File classes to the
 * installs whose probe it waits for: its own package's for a package Check,
 * every package's with a probe for a project Check. A package without a
 * probe has nothing to wait for.
 */
export function resolveProbeWaits(all: Planned[]): void {
  for (const p of all) {
    if (p.check.readsFileClasses?.() !== true) {
      continue;
    }
    for (const c of probedContexts(all, p)) {
      const q = findPlanned(all, packageInstallCheck, c);
      if (q !== undefined && q !== p && q.applicability !== NotApplicable) {
        p.waits.push(q);
      }
    }
  }
}

/**
 * probedContexts lists the package Contexts whose files the execution
 * examines and whose tests have a probe, in plan order.
 */
function probedContexts(all: Planned[], p: Planned): Context[] {
  if (p.context.package !== null) {
    return hasTestFileProbe(p.context) ? [p.context] : [];
  }
  const out: Context[] = [];
  const seen = new Set<string>();
  for (const q of all) {
    if (
      q.entry.id === packageInstallCheck &&
      q.context.package !== null &&
      !seen.has(q.context.id) &&
      hasTestFileProbe(q.context)
    ) {
      seen.add(q.context.id);
      out.push(q.context);
    }
  }
  return out;
}

export function findPlanned(
  all: readonly Planned[],
  checkID: string,
  c: Context,
): Planned | undefined {
  return all.find((q) => q.entry.id === checkID && q.context.id === c.id);
}

/**
 * prerequisitesRun lists, in Catalog order, the Checks that ran without
 * being selected because a selected Check needed them.
 */
export function prerequisitesRun(r: RunState): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  // The secret scan reports itself in r.prerequisites (see takeSecretScan).
  for (const id of r.prerequisites) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  for (const p of r.planned) {
    if (p.prerequisite && runnable(p) && !seen.has(p.entry.id)) {
      seen.add(p.entry.id);
      ids.push(p.entry.id);
    }
  }
  const order = new Map(implementedIDs().map((id, i) => [id, i]));
  // The IDs are distinct, so the unstable sort of Go and this stable one agree.
  return ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * blockedByPrerequisite returns the result of an execution that cannot run
 * because a prerequisite did not complete without a Gate, or null when it
 * can. What happened to the dependent follows from what happened to the
 * prerequisite: unsupported stays unsupported, a Gate is the project's fault,
 * and anything else that kept the prerequisite from completing is the Run's.
 */
export function blockedByPrerequisite(
  r: RunState,
  p: Planned,
): ExecResult | null {
  for (const q of p.needs) {
    const qr = r.finishedResult(q);
    if (qr === undefined) {
      return stopped(
        p,
        StatusBlocked,
        reasonPrerequisiteNotRun,
        `${q.entry.id} has to run first, but it did not run in this Context`,
      );
    }
    const status = qr.exec.status;
    if (status === StatusCompleted && qr.gates === 0) {
      continue;
    }
    if (status === StatusUnsupported) {
      return stopped(
        p,
        StatusUnsupported,
        qr.exec.reason_code ?? "",
        qr.exec.reason ?? "",
      );
    }
    if (status === StatusCompleted) {
      return stopped(
        p,
        StatusBlocked,
        reasonPrerequisiteFailedProject,
        `${q.entry.id} failed because of the project, so there is nothing to examine: ${qr.failure}`,
      );
    }
    if (status === StatusCancelled || status === StatusBudgetExhausted) {
      return stopped(
        p,
        status,
        qr.exec.reason_code ?? "",
        `${q.entry.id} did not finish: ${qr.exec.reason ?? ""}`,
      );
    }
    let code = reasonPrerequisiteFailedRun;
    const specific = qr.exec.reason_code ?? "";
    if (
      specific !== "" &&
      (status === StatusBlocked || status === StatusInfrastructureError)
    ) {
      code = specific;
    }
    return stopped(
      p,
      StatusBlocked,
      code,
      `${q.entry.id} did not complete (${status}), so there is nothing to examine: ${qr.exec.reason ?? ""}`,
    );
  }
  return null;
}
