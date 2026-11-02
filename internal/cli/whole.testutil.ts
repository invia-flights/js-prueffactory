// A reader of report.json with the fields that the whole-Run Docker tests
// look at: the Run on the default Selection, the Benchmark section, the
// Redaction and the Findings of syntax.parse (Go: cli_docker_test.go,
// benchmark_docker_test.go, redaction_env_docker_test.go,
// redaction_closed_vocabulary_docker_test.go, budget_docker_test.go).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DockerRun } from "./realrun.testutil.ts";

export interface WholeFinding {
  id: string;
  check_id: string;
  rule_id: string | null;
  kind: string;
  gate: boolean;
  severity: string;
  confidence: string;
  in_test_data: boolean;
  title: string;
  message: string;
  fingerprint: { algorithm: string; value: string };
  locations: {
    role: string;
    path_base: string;
    path: string;
    file_sha256: string;
    start: { line: number; column: number | null } | null;
    snippet: { text: string } | null;
  }[];
  evidence: { kind: string; origin: string; trust: string; text: string }[];
  reproduction: {
    rerun_command: string[];
    verified_by: string[];
    test: {
      runner: string;
      file: string;
      full_title: string;
      native_command: string[];
    } | null;
  };
}

export interface WholeExecution {
  id: string;
  check_id: string;
  context_id: string;
  family: string;
  selected: boolean;
  applicability: string;
  status: string;
  outcome: string;
  gate: number;
  reason_code: string | null;
  reason: string | null;
  tool: { name: string; version: string | null } | null;
  finding_ids: string[];
}

export interface BenchmarkPart {
  id: string;
  state: string;
  raw_value: number | null;
  score: number | null;
  reason: string | null;
}

export interface BenchmarkArea {
  id: string;
  exists: boolean;
  fully_measured: boolean;
  score: number | null;
  parts: BenchmarkPart[];
}

export interface Whole {
  schema_version: string;
  run: {
    id: string;
    status: string;
    command: string;
    exit_code: number;
    budget_seconds: number;
    budget_source: string;
  };
  profiles: { catalog_version: string; execution_profile: string };
  source: {
    original_unchanged: boolean;
    changed_paths: string[];
    file_count: number;
    snapshot_algorithm: string;
    snapshot_hash: string;
  };
  selection: {
    fast: boolean;
    effective_checks: string[];
    deselected_checks: string[];
  };
  limitations: { reason_code: string; message: string; path: string | null }[];
  contexts: {
    id: string;
    kind: string;
    node: {
      version: string;
      variant: string;
      image: string;
    } | null;
  }[];
  checks: WholeExecution[];
  findings: WholeFinding[];
  services: { family: string; compose_service: string }[];
  summary: { gates: number };
  report_completeness: {
    redaction: { applied: boolean; count: number; reason: string | null };
  };
  benchmark: {
    status: string;
    profile_id: string | null;
    score: number | null;
    verdict: string | null;
    range: { low: number; high: number } | null;
    gate_finding_ids: string[];
    areas: BenchmarkArea[];
    side_indicators: {
      id: string;
      state: string;
      value: number | null;
    }[];
    fingerprint: {
      hash: string;
      fields: {
        runtimes: unknown[];
        eslint_config_hashes: unknown[];
        image_digests: unknown[];
        advisory_database_date: string | null;
        toolset_version: string;
      };
    } | null;
  };
}

/** whole reads report.json of a Run. */
export function whole(r: DockerRun): Whole {
  assert.notEqual(r.reportDir, "", `no report folder\n${r.stderr}`);
  return JSON.parse(
    readFileSync(join(r.reportDir, "report.json"), "utf8"),
  ) as Whole;
}

/** wholeFindingsOf are the Findings of a Check. */
export function wholeFindingsOf(s: Whole, check: string): WholeFinding[] {
  return s.findings.filter((f) => f.check_id === check);
}

/** benchmarkPartOf is a part of the Benchmark section; it fails the test when there is none. */
export function benchmarkPartOf(s: Whole, id: string): BenchmarkPart {
  for (const a of s.benchmark.areas) {
    const p = a.parts.find((x) => x.id === id);
    if (p) return p;
  }
  assert.fail(`no part ${id} in the Benchmark section`);
}

/** benchmarkAreaOf is an area of the Benchmark section; it fails the test when there is none. */
export function benchmarkAreaOf(s: Whole, id: string): BenchmarkArea {
  const a = s.benchmark.areas.find((x) => x.id === id);
  assert.ok(a, `no area ${id} in the Benchmark section`);
  return a;
}

/**
 * walkJSON calls fn for every string of a decoded JSON document with the name
 * of the object key it sits under, or of the nearest one for a list element.
 */
export function walkJSON(
  v: unknown,
  key: string,
  fn: (key: string, value: string) => void,
): void {
  if (typeof v === "string") {
    fn(key, v);
  } else if (Array.isArray(v)) {
    for (const e of v) walkJSON(e, key, fn);
  } else if (typeof v === "object" && v !== null) {
    for (const [k, e] of Object.entries(v)) walkJSON(e, k, fn);
  }
}

/** filesBelow lists the files below a folder, recursively. */
export function filesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesBelow(p));
    else out.push(p);
  }
  return out;
}
