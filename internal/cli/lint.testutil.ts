// Readers of report.json for the Docker tests of the lint Checks (Go: the
// helpers of cli_eslint_docker_test.go, cli_eslint_groups_docker_test.go,
// lint_existing_docker_test.go and lint_typed_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DockerRun } from "./realrun.testutil.ts";
import type { Execution, Finding, Limitation } from "./suites.testutil.ts";

/** LintReport is the part of report.json these tests read. */
export interface LintReport {
  selection: { prerequisites_run: string[] };
  limitations: Limitation[];
  contexts: {
    id: string;
    kind: string;
    tools: { name: string; version: string; digest: string | null }[];
  }[];
  checks: Execution[];
  findings: Finding[];
  artifacts: { id: string; path: string; check_id: string }[];
  inventory: {
    file_hashes: { path: string; role: string }[];
    moved_test_files: {
      context_id: string;
      path: string;
      suite: string;
      kind: string;
    }[];
  };
  metrics: {
    check_id: string;
    name: string;
    value: number | null;
    reason: string | null;
  }[];
  summary: { gates: number };
  benchmark: {
    score: number | null;
    range: { low: number; high: number } | null;
    fingerprint: {
      fields: { typed_lint_rules_hash: string | null };
    } | null;
    areas: {
      parts: {
        id: string;
        state: string;
        raw_value: number | null;
        score: number | null;
        n_eff: number | null;
        reason: string | null;
      }[];
    }[];
  };
}

/** lintReport reads report.json of a Run. */
export function lintReport(r: DockerRun): LintReport {
  assert.notEqual(r.reportDir, "", `no report folder\n${r.stderr}`);
  return JSON.parse(
    readFileSync(join(r.reportDir, "report.json"), "utf8"),
  ) as LintReport;
}

/** executionsOf are the executions of a Check, in report order. */
export function executionsOf(s: LintReport, check: string): Execution[] {
  return s.checks.filter((e) => e.check_id === check);
}

/** oneExecution is the only execution of a Check; it fails the test when there is not exactly one. */
export function oneExecution(s: LintReport, check: string): Execution {
  const found = executionsOf(s, check);
  assert.equal(
    found.length,
    1,
    `executions of ${check}: ${String(found.length)}`,
  );
  const [e] = found;
  assert.ok(e);
  return e;
}

/** packageExecution is the execution of a Check in the package Context C-0002. */
export function packageExecution(
  r: DockerRun,
  s: LintReport,
  check: string,
): Execution {
  const e = s.checks.find(
    (x) => x.check_id === check && x.context_id === "C-0002",
  );
  assert.ok(e, `no ${check} execution in the package Context\n${r.stderr}`);
  return e;
}

/** findingsOf are the Findings of a Check. */
export function findingsOf(s: LintReport, check: string): Finding[] {
  return s.findings.filter((f) => f.check_id === check);
}

/** artifactOf is the artifact of an execution whose path ends in name. */
export function artifactOf(
  s: LintReport,
  e: Execution,
  name: string,
): { id: string; path: string } | undefined {
  return s.artifacts.find(
    (a) => e.artifact_ids.includes(a.id) && a.path.endsWith(name),
  );
}

/** partOf is a part of the Benchmark section; it fails the test when there is none. */
export function partOf(
  s: LintReport,
  id: string,
): LintReport["benchmark"]["areas"][number]["parts"][number] {
  for (const a of s.benchmark.areas) {
    const p = a.parts.find((x) => x.id === id);
    if (p) {
      return p;
    }
  }
  assert.fail(`no Benchmark part ${id}`);
}
