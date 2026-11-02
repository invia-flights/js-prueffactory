import type { Context, Project } from "../discovery/discovery.ts";
import { type Applicability, NotApplicable } from "../resultset/types.ts";
import { type Entry, PerProject } from "./catalog.ts";
import type { Check } from "./check.ts";

/**
 * Placement is one Check in one Context, with its Applicability there. Runs
 * and `list-checks` both ask for Placements, so they agree on what a Check
 * covers.
 */
export interface Placement {
  context: Context;
  applicability: Applicability;
  reason: string;
}

/**
 * placements lists where a Check applies. Per-package Checks get one
 * Placement in every package Context, per-project Checks one in the project
 * Context. A per-package Check in a project without packages gets one
 * not_applicable Placement in the project Context, so a Check is never left
 * out silently.
 */
export function placements(
  proj: Project,
  entry: Pick<Entry, "scope">,
  impl: Check,
): Placement[] {
  const place = (c: Context): Placement => {
    const [applicability, reason] = impl.applicability(proj, c);
    return { context: c, applicability, reason };
  };
  const project = proj.contexts[0];
  if (project === undefined) {
    throw new Error("checks: the project has no project Context");
  }
  if (entry.scope === PerProject) {
    return [place(project)];
  }
  const out: Placement[] = [];
  for (const c of proj.contexts) {
    if (c.package !== null) {
      out.push(place(c));
    }
  }
  if (out.length === 0) {
    out.push({
      context: project,
      applicability: NotApplicable,
      reason: "the project has no package.json",
    });
  }
  return out;
}
