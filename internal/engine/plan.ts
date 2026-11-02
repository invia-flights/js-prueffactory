// The Selection and the list of executions (Go: plan.go).
import { type Entry, implementedIDs, lookup } from "../checks/catalog.ts";
import { type Check, implementation } from "../checks/check.ts";
import { placements } from "../checks/placement.ts";
import { SecretsCheckID } from "../checks/security_secrets.ts";
import { type Selection, selected } from "../checks/selection.ts";
import type { Context, Project } from "../discovery/discovery.ts";
import { type Applicability, NotApplicable } from "../resultset/types.ts";
import { resolvePrerequisites, resolveProbeWaits } from "./prerequisites.ts";

/**
 * Planned is one Check execution the Run will perform or report as not
 * applicable: one Check in one Context.
 */
export interface Planned {
  /** key is the temporary execution key, replaced by E-0001 and so on. */
  key: string;
  entry: Entry;
  check: Check;
  context: Context;
  applicability: Applicability;
  reason: string;
  /**
   * deselected is true for a Check the Selection leaves out. It is reported
   * as not started and never runs, unless it is a prerequisite.
   */
  deselected: boolean;
  /** byFast is true when --fast, and not --only or --exclude, left it out. */
  byFast: boolean;
  /**
   * prerequisite is true for a deselected Check that runs anyway because
   * something else depends on it: the secret scan, because redaction needs
   * the values it finds, and every Check that a selected one needs. It runs,
   * is reported as not selected and reports no Findings.
   */
  prerequisite: boolean;
  /** needs are the executions that must finish before this one starts. */
  needs: Planned[];
  /**
   * waits are the installs whose test file probe this execution waits for,
   * because it reads File classes. What became of them does not matter.
   */
  waits: Planned[];
  /**
   * follows are the executions that run before this one without it needing
   * them to succeed (Check.runsAfter). A deselected one runs as a
   * prerequisite.
   */
  follows: Planned[];
  /**
   * orderedAfter are the executions this one starts after when they run
   * (Check.orderedAfter). A deselected one stays deselected.
   */
  orderedAfter: Planned[];
}

/** runnable says whether the execution has to be performed. */
export function runnable(p: Planned): boolean {
  return (!p.deselected || p.prerequisite) && p.applicability !== NotApplicable;
}

/**
 * plan lists one execution per implemented Check and Context. A Check that
 * the Selection leaves out is planned too, as deselected, so the Report names
 * it and Standard completeness counts it. Placements decides where a Check
 * runs.
 */
export function plan(proj: Project, sel: Selection): Planned[] {
  const out: Planned[] = [];
  for (const id of implementedIDs()) {
    const entry = lookup(id);
    const impl = implementation(id);
    if (entry === undefined || impl === undefined) {
      continue;
    }
    for (const pl of placements(proj, entry, impl)) {
      const deselected = !selected(sel, id);
      out.push({
        key: `x${String(out.length + 1)}`,
        entry,
        check: impl,
        context: pl.context,
        applicability: pl.applicability,
        reason: pl.reason,
        deselected,
        byFast: sel.deselectedByFast.includes(id),
        prerequisite: deselected && id === SecretsCheckID,
        needs: [],
        waits: [],
        follows: [],
        orderedAfter: [],
      });
    }
  }
  resolveProbeWaits(out);
  resolvePrerequisites(out);
  return out;
}
