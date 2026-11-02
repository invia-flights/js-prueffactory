// Readers and project edits for the Docker tests of tests.existing and the
// Services (Go: the helpers of tests_existing_docker_test.go,
// tests_existing_edges_docker_test.go, tests_existing_visibility_docker_test.go
// and services_docker_test.go).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DockerRun } from "./realrun.testutil.ts";

export interface Limitation {
  reason_code: string;
  message: string;
  check_id: string | null;
  path: string | null;
}

export interface Execution {
  id: string;
  check_id: string;
  context_id: string;
  selected: boolean;
  applicability: string;
  status: string;
  outcome: string;
  gate: number;
  reason_code: string | null;
  reason: string | null;
  command: string[];
  tool: {
    name: string;
    version: string | null;
    exit_code: number | null;
  } | null;
  artifact_ids: string[];
  finding_ids: string[];
}

export interface Finding {
  id: string;
  check_id: string;
  execution_id: string;
  context_id: string;
  rule_id: string | null;
  gate: boolean;
  severity: string;
  confidence: string;
  suite: string | null;
  in_test_code: boolean;
  title: string;
  message: string;
  expected: string | null;
  actual: string | null;
  limitations: string[];
  locations: {
    path: string;
    file_sha256: string;
    start: { line: number; column: number | null } | null;
  }[];
  evidence: { kind: string; text: string; trust: string }[];
  reproduction: {
    rerun_command: string[];
    test: {
      runner: string;
      file: string;
      full_title: string;
      native_command: string[];
    } | null;
  };
}

export interface TestCase {
  execution_id: string;
  file: string;
  suite: string;
  full_title: string;
  suite_path: string[];
  outcome: string;
  never_run_reason: string | null;
  flaky: boolean;
  attempts: { outcome: string; duration_ms: number; error: string | null }[];
  finding_ids: string[];
}

export interface PackageTests {
  context_id: string;
  found: number;
  run: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  focused: number;
  never_run: number;
}

export interface ServiceRow {
  family: string;
  compose_service: string;
  image: string | null;
  image_digest: string | null;
  declared_image: string;
  context_ids: string[];
  status: string;
  reason: string | null;
}

/** Full is the part of report.json these tests read. */
export interface Full {
  run: { status: string; exit_code: number };
  source: { original_path: string };
  selection: {
    effective_checks: string[];
    prerequisites_run: string[];
  };
  limitations: Limitation[];
  contexts: {
    id: string;
    kind: string;
    path: string;
    node: {
      version: string;
      source: string;
      variant: string;
      image_digest: string;
    } | null;
  }[];
  checks: Execution[];
  findings: Finding[];
  test_cases: TestCase[];
  services: ServiceRow[];
  artifacts: { id: string; path: string; check_id: string }[];
  inventory: {
    tests: PackageTests[];
    test_suites: (PackageTests & { suite: string })[];
    test_files: {
      context_id: string;
      suite: string;
      file: string;
      found: number;
      passed: number;
    }[];
    moved_test_files: {
      context_id: string;
      path: string;
      suite: string;
      kind: string;
    }[];
  };
  metrics: {
    check_id: string;
    context_id: string;
    name: string;
    value: number | null;
  }[];
  summary: {
    gates: number;
    network_isolation: string;
    test_cases: {
      passed: number;
      failed: number;
      skipped: number;
      todo: number;
      never_run: number;
    };
  };
  report_completeness: {
    redaction: { applied: boolean; count: number };
  };
}

/** full reads report.json of a Run, with every field these tests use. */
export function full(r: DockerRun): Full {
  assert.notEqual(r.reportDir, "", `no report folder\n${r.stderr}`);
  return JSON.parse(
    readFileSync(join(r.reportDir, "report.json"), "utf8"),
  ) as Full;
}

/** executionsOf are the executions of a Check that ran (not_applicable ones left out). */
export function executionsOf(s: Full, check: string): Execution[] {
  return s.checks.filter(
    (e) => e.check_id === check && e.applicability !== "not_applicable",
  );
}

/** oneExecution is the only execution of a Check. */
export function oneExecution(s: Full, check: string): Execution {
  const got = executionsOf(s, check);
  assert.equal(got.length, 1, `${check} executions = ${JSON.stringify(got)}`);
  const e = got[0];
  assert.ok(e);
  return e;
}

/** findingsOf are the Findings of a Check. */
export function findingsOf(s: Full, check: string): Finding[] {
  return s.findings.filter((f) => f.check_id === check);
}

/** testCasesOf are the test cases of an execution. */
export function testCasesOf(s: Full, execution: string): TestCase[] {
  return s.test_cases.filter((t) => t.execution_id === execution);
}

/** inventoryOf is the Inventory's test count row of a Context. */
export function inventoryOf(s: Full, contextID: string): PackageTests {
  const p = s.inventory.tests.find((x) => x.context_id === contextID);
  assert.ok(p, `no test inventory for ${contextID}`);
  return p;
}

/** limitationOf is the first Limitation with the reason code, or undefined. */
export function limitationOf(s: Full, code: string): Limitation | undefined {
  return s.limitations.find((l) => l.reason_code === code);
}

/** serviceNamed is the Service of the compose name; it fails the test when there is none. */
export function serviceNamed(s: Full, name: string): ServiceRow {
  const sv = s.services.find((x) => x.compose_service === name);
  assert.ok(sv, `no Service ${name} in ${JSON.stringify(s.services)}`);
  return sv;
}

/** packageContext is the first package Context. */
export function packageContext(s: Full): Full["contexts"][number] {
  const c = s.contexts.find((x) => x.kind === "package");
  assert.ok(c, "no package Context");
  return c;
}

/** counts is a PackageTests row with the given counts and zeros elsewhere. */
export function counts(
  contextID: string,
  c: Partial<PackageTests>,
): PackageTests {
  return {
    context_id: contextID,
    found: 0,
    run: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
    ...c,
  };
}

/** artifactOf is the artifact of an execution whose path ends in name. */
export function artifactOf(
  s: Full,
  e: Execution,
  name: string,
): { id: string; path: string } | undefined {
  return s.artifacts.find(
    (a) => e.artifact_ids.includes(a.id) && a.path.endsWith("/" + name),
  );
}

interface PassedCase {
  full_title: string;
  flaky: boolean;
  attempts: { outcome: string; duration_ms: number; error: string | null }[];
}

/** passedCasesOf reads the artifact that lists the passed test cases of an execution. */
export function passedCasesOf(
  r: DockerRun,
  s: Full,
  e: Execution,
): PassedCase[] {
  const a = artifactOf(s, e, `tests.existing-${e.context_id}-passed.json`);
  if (a === undefined) {
    return [];
  }
  const doc = JSON.parse(readFileSync(join(r.reportDir, a.path), "utf8")) as {
    passed: PassedCase[];
  };
  return doc.passed;
}

/** passedTitles are the full titles of the passed test cases of an execution. */
export function passedTitles(r: DockerRun, s: Full, e: Execution): string[] {
  return passedCasesOf(r, s, e).map((p) => p.full_title);
}

/** overrideMessages are the messages of the test_command_override Limitations, one per line. */
export function overrideMessages(s: Full): string {
  return s.limitations
    .filter((l) => l.reason_code === "test_command_override")
    .map((l) => l.message)
    .join("\n");
}

/** withoutSecretScan drops the secret scan, which every Run starts as a prerequisite of redaction. */
export function withoutSecretScan(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== "security.secrets");
}

/** writeFiles adds or replaces files of a project copy. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** removeFile removes a file of a project copy. */
export function removeFile(dir: string, rel: string): void {
  rmSync(join(dir, rel));
}

/** setTestScript changes scripts.test of a project copy. */
export function setTestScript(dir: string, script: string): void {
  const p = join(dir, "package.json");
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  m.scripts = { test: script };
  writeFileSync(p, JSON.stringify(m, null, 2));
}
