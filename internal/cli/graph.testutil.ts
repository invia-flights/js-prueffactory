// Readers for the Docker tests of quality.unused, modules.cycles and
// quality.clones (Go: the helpers of unused_cycles_docker_test.go,
// unused_mocha_docker_test.go and cli_clones_docker_test.go).
import type { DockerRun } from "./realrun.testutil.ts";
import {
  type Finding,
  findingsOf,
  type Full,
  full,
} from "./suites.testutil.ts";

/** ruleFindings are the Findings of one rule of a Check. */
export function ruleFindings(s: Full, check: string, rule: string): Finding[] {
  return findingsOf(s, check).filter((f) => f.rule_id === rule);
}

/** unusedSummary lists what quality.unused reports, as "rule evidence" lines. */
export function unusedSummary(s: Full): string[] {
  return findingsOf(s, "quality.unused")
    .map((f) => `${f.rule_id ?? ""} ${f.evidence[0]?.text ?? ""}`)
    .sort();
}

/** devDependencyFiles maps the primary path of each dev-dependency-in-production Finding to the Finding. */
export function devDependencyFiles(s: Full): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const f of ruleFindings(
    s,
    "modules.cycles",
    "dev-dependency-in-production",
  )) {
    out.set(f.locations[0]?.path ?? "", f);
  }
  return out;
}

/** entryPointsUnknown is the production_entry_points_unknown Limitation of modules.cycles, if there is one. */
export function entryPointsUnknown(s: Full) {
  return s.limitations.find(
    (l) =>
      l.reason_code === "production_entry_points_unknown" &&
      l.check_id === "modules.cycles",
  );
}

/** ContextTools are the tools the Report records per Context. */
export interface ContextTools {
  id: string;
  tools: { name: string; version: string; digest: string | null }[];
}

/** contextTools reads the tools of every Context of the Report. */
export function contextTools(r: DockerRun): ContextTools[] {
  return (full(r) as unknown as { contexts: ContextTools[] }).contexts;
}
