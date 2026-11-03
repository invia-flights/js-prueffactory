// Readers of report.json for the Docker tests of the parse and description
// Checks: syntax.parse, artifacts.structured, schema.compile, api.lint and
// schema.drift (Go: the helpers of their *_docker_test.go files).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DockerRun } from "./realrun.testutil.ts";

/** ParseReport is the part of report.json these tests read. */
export interface ParseReport {
  selection: {
    only: string[];
    exclude: string[];
    effective_checks: string[];
    deselected_checks: string[];
    is_standard_scope: boolean;
  };
  limitations: {
    reason_code: string;
    message: string;
    check_id: string | null;
    path: string | null;
  }[];
  contexts: {
    id: string;
    kind: string;
    path: string;
    tools: { name: string; version: string; digest: string | null }[];
  }[];
  checks: {
    check_id: string;
    context_id: string;
    selected: boolean;
    applicability: string;
    status: string;
    outcome: string;
    gate: number;
    reason_code: string | null;
    reason: string | null;
    tool: { name: string; version: string | null } | null;
  }[];
  findings: {
    id: string;
    check_id: string;
    context_id: string;
    rule_id: string | null;
    gate: boolean;
    severity: string;
    confidence: string;
    in_test_data: boolean;
    in_test_code: boolean;
    in_documentation: boolean;
    title: string;
    message: string;
    locations: {
      path: string;
      start: { line: number; column: number | null } | null;
    }[];
    evidence: { text: string; trust: string; artifact_id: string | null }[];
  }[];
  artifacts: { id: string; path: string }[];
  inventory: { size: { group: string; name: string; lines: number }[] };
  summary: {
    gates: number;
    scope_completeness: { required: number; completed: number };
    standard_completeness: { required: number; completed: number };
  };
  benchmark: {
    areas: {
      parts: {
        id: string;
        state: string;
        raw_value: number | null;
        reason: string | null;
      }[];
    }[];
  } | null;
}

export type ParseExecution = ParseReport["checks"][number];
export type ParseFinding = ParseReport["findings"][number];

/** parseReport reads report.json of a Run. */
export function parseReport(r: DockerRun): ParseReport {
  assert.notEqual(r.reportDir, "", `no report folder\n${r.stderr}`);
  return JSON.parse(
    readFileSync(join(r.reportDir, "report.json"), "utf8"),
  ) as ParseReport;
}

/** executionIn is the execution of a Check; it fails the test when there is none. */
export function executionIn(s: ParseReport, check: string): ParseExecution {
  const e = s.checks.find((x) => x.check_id === check);
  assert.ok(e, `no execution of ${check}`);
  return e;
}

/** findingsIn are the Findings of a Check. */
export function findingsIn(s: ParseReport, check: string): ParseFinding[] {
  return s.findings.filter((f) => f.check_id === check);
}

/** byPath are Findings by the path of their primary location. */
export function byPath(found: ParseFinding[]): Map<string, ParseFinding> {
  return new Map(found.map((f) => [f.locations[0]?.path ?? "", f]));
}

/** gatesIn are the Gate Findings of a Check by the path of their primary location. */
export function gatesIn(
  s: ParseReport,
  check: string,
): Map<string, ParseFinding> {
  return byPath(findingsIn(s, check).filter((f) => f.gate));
}

/**
 * errorsIn are the error Findings of a Check by the path of their primary
 * location, whether they are Gates or not.
 */
export function errorsIn(
  s: ParseReport,
  check: string,
): Map<string, ParseFinding> {
  return byPath(findingsIn(s, check).filter((f) => f.severity === "error"));
}

/** benchmarkPart is a part of the Benchmark section; it fails the test when there is none. */
export function benchmarkPart(
  s: ParseReport,
  id: string,
): NonNullable<ParseReport["benchmark"]>["areas"][number]["parts"][number] {
  for (const a of s.benchmark?.areas ?? []) {
    const p = a.parts.find((x) => x.id === id);
    if (p) {
      return p;
    }
  }
  assert.fail(`no Benchmark part ${id}`);
}
