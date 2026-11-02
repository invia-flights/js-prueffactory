// Readers of report.json for the repository Check Docker tests (Go: the
// helpers of repository_files_docker_test.go and kubernetes_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DockerRun } from "./realrun.testutil.ts";

/** FullReport is the part of report.json these tests read. */
export interface FullReport {
  limitations: {
    reason_code: string;
    message: string;
    check_id: string | null;
    path: string | null;
  }[];
  contexts: {
    id: string;
    tools: { name: string; version: string; digest: string | null }[];
  }[];
  checks: {
    check_id: string;
    context_id: string;
    applicability: string;
    status: string;
    outcome: string;
    gate: number;
    reason: string | null;
    tool: { name: string; version: string | null } | null;
  }[];
  findings: {
    check_id: string;
    rule_id: string | null;
    gate: boolean;
    severity: string;
    confidence: string;
    title: string;
    message: string;
    locations: { path: string; start: { line: number } | null }[];
    evidence: { text: string; trust: string }[];
  }[];
  summary: { gates: number };
  benchmark: {
    areas: {
      parts: {
        id: string;
        state: string;
        raw_value: number | null;
        n_eff: number | null;
      }[];
    }[];
    fingerprint: {
      fields: {
        kubernetes_schema_version: string | null;
        gitlab_ci_schema_hash: string | null;
      };
    };
  } | null;
}

export type Execution = FullReport["checks"][number];
export type ReportFinding = FullReport["findings"][number];

/** fullReport reads report.json of a Run. */
export function fullReport(r: DockerRun): FullReport {
  assert.notEqual(r.reportDir, "", `no report folder\n${r.stderr}`);
  return JSON.parse(
    readFileSync(join(r.reportDir, "report.json"), "utf8"),
  ) as FullReport;
}

/** executionOf is the execution of a Check; it fails the test when there is none. */
export function executionOf(s: FullReport, check: string): Execution {
  const e = s.checks.find((x) => x.check_id === check);
  assert.ok(e, `no execution of ${check}`);
  return e;
}

/** findingsOf are the Findings of a Check. */
export function findingsOf(s: FullReport, check: string): ReportFinding[] {
  return s.findings.filter((f) => f.check_id === check);
}

/** gatesByPath are the Gate Findings of a Check by the path of their primary location. */
export function gatesByPath(
  s: FullReport,
  check: string,
): Map<string, ReportFinding> {
  const out = new Map<string, ReportFinding>();
  for (const f of findingsOf(s, check)) {
    if (f.gate) {
      out.set(f.locations[0]?.path ?? "", f);
    }
  }
  return out;
}

/** limitationsOf are the Limitations of a Check. */
export function limitationsOf(
  s: FullReport,
  check: string,
): FullReport["limitations"] {
  return s.limitations.filter((l) => l.check_id === check);
}

/** projectTools are the tools of the project Context by name. */
export function projectTools(
  s: FullReport,
): Map<string, FullReport["contexts"][number]["tools"][number]> {
  return new Map((s.contexts[0]?.tools ?? []).map((t) => [t.name, t]));
}
