import { finalize } from "../finalize.ts";
import { newFingerprint } from "../fingerprint.ts";
import {
  Applicable,
  BenchmarkNotRequested,
  ConfidenceConfirmed,
  FormatID,
  IsolationNotProbed,
  KindDefect,
  SchemaVersion,
  type Set,
  SeverityError,
  StatusCompleted,
  TestFailed,
  TrustUntrusted,
} from "../types.ts";
import {
  newArtifact,
  newBenchmark,
  newContext,
  newExecution,
  newFinding,
  newMetric,
  newRun,
  newService,
  newSet,
  newTestCase,
} from "../zero.ts";
import { fixtureTime, SHA } from "./sample.testutil.ts";

/**
 * populated returns a finalized test mode result set that uses every section
 * of the Report contract except the benchmark details (scoredProject covers
 * those), so a field added to a type but not to the schema (or the other way
 * round) fails where it is used, and a closed-vocabulary field that redaction
 * would rewrite shows up as an invalid Report.
 */
export function populated(): Set {
  const at = new Date(fixtureTime);
  const s = newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    producer: {
      name: "js-prueffactory",
      version: "0.1.0",
      vcs_revision: "abc",
    },
    run: newRun({
      id: "20261025T101500Z-x-aaaa",
      command: "test",
      started_at: at,
      finished_at: new Date(fixtureTime + 60_000),
      duration_ms: 60000,
      budget_seconds: 1800,
      budget_source: "default",
      host: { os: "darwin", arch: "arm64" },
      docker: {
        server_version: "29.4.0",
        api_version: "1.56",
        cpus: 8,
        memory_bytes: 2 ** 33,
      },
    }),
    source: {
      original_path: "/p",
      snapshot_algorithm: "sorted-path-sha256-v1",
      snapshot_hash: SHA,
      file_count: 3,
      git: { commit: "deadbeef", dirty: "unknown" },
      original_unchanged: true,
      changed_paths: [],
      excluded_paths: [],
    },
    profiles: {
      catalog_version: "1",
      execution_profile: "execution-v0",
      benchmark_profile: null,
      toolset_version: "abc",
    },
    selection: {
      only: ["syntax"],
      exclude: [],
      effective_checks: ["syntax.parse"],
      deselected_checks: [],
      prerequisites_run: [],
      is_standard_scope: false,
      fast: false,
    },
    contexts: [
      newContext({ id: "C-0001", kind: "project", path: "." }),
      newContext({
        id: "C-0002",
        kind: "package",
        path: ".",
        npm_version: "11.0.0",
        node: {
          version: "24",
          source: "default",
          image: "node@sha256:" + SHA,
          image_digest: "sha256:" + SHA,
          variant: "debian",
          not_checked_versions: [],
        },
        tools: [{ name: "node", version: "24.22.1", digest: "sha256:" + SHA }],
        limits: { cpus: 2, memory_mb: 4096 },
      }),
    ],
    services: [
      newService({
        family: "valkey",
        compose_service: "redis",
        image: "valkey",
        image_digest: "sha256:x",
        declared_image: "valkey/valkey:8",
        context_ids: ["C-0002"],
        status: "started",
      }),
    ],
    benchmark: newBenchmark({ status: BenchmarkNotRequested }),
    checks: [
      newExecution({
        id: "tmp",
        check_id: "tests.existing",
        family: "tests",
        context_id: "C-0002",
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
        started_at: at,
        duration_ms: 5,
        tool: { name: "mocha", version: "10.8.2", exit_code: 1 },
        command: ["mocha"],
        artifact_ids: ["art"],
      }),
    ],
    test_cases: [
      newTestCase({
        id: "t",
        execution_id: "tmp",
        file: "test/a.js",
        suite: "scripts.test",
        full_title: "a b",
        suite_path: ["a"],
        outcome: TestFailed,
        flaky: false,
        finding_ids: ["f"],
        attempts: [{ outcome: TestFailed, duration_ms: 3, error: "boom" }],
      }),
    ],
    findings: [
      newFinding({
        id: "f",
        check_id: "tests.existing",
        execution_id: "tmp",
        context_id: "C-0002",
        rule_id: "assertion",
        fingerprint: newFingerprint(
          "tests.existing",
          "assertion",
          "test/a.js",
          "a b",
        ),
        kind: KindDefect,
        severity: SeverityError,
        confidence: ConfidenceConfirmed,
        gate: true,
        title: "t",
        message: "m",
        locations: [
          {
            role: "primary",
            path_base: "project_root",
            path: "test/a.js",
            file_sha256: SHA,
            start: { line: 3, column: 5 },
            end: { line: 3, column: null },
            snippet: { start_line: 3, text: "x" },
          },
        ],
        expected: "1",
        actual: "2",
        evidence: [
          {
            kind: "stack",
            text: "x",
            origin: "mocha",
            trust: TrustUntrusted,
            original_size: 9000,
            artifact_id: "art",
          },
        ],
        reproduction: {
          rerun_command: ["js-prueffactory", "test", "/p"],
          test: {
            runner: "mocha",
            file: "test/a.js",
            full_title: "a b",
            native_command: ["mocha", "--fgrep", "a b"],
          },
          verified_by: ["tests.existing"],
        },
        limitations: ["x"],
        suite: "scripts.test",
      }),
    ],
    metrics: [
      newMetric({
        id: "m",
        check_id: "quality.size",
        context_id: "C-0001",
        name: "lines",
        value: 10,
        unit: "lines",
      }),
    ],
    inventory: {
      tests: [
        {
          context_id: "C-0002",
          found: 5,
          run: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          todo: 0,
          focused: 0,
          never_run: 0,
        },
      ],
      test_suites: [
        {
          context_id: "C-0002",
          suite: "scripts.test",
          found: 5,
          run: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          todo: 0,
          focused: 0,
          never_run: 0,
        },
      ],
      test_files: [
        {
          context_id: "C-0002",
          suite: "scripts.test",
          file: "test/a.js",
          found: 5,
          passed: 0,
          passed_focused: 0,
        },
      ],
      suppressions: [
        { kind: "eslint-disable", file_class: "source", count: 1 },
      ],
      file_hashes: [{ path: "package.json", role: "manifest", sha256: SHA }],
      size: [{ group: "extension", name: ".js", lines: 3, non_blank_lines: 2 }],
      moved_test_files: [
        {
          context_id: "C-0002",
          path: "src/a.spec.js",
          suite: "scripts.test",
          kind: "spec",
        },
      ],
    },
    limitations: [
      { reason_code: "x", message: "m", check_id: "syntax.parse", path: "a" },
    ],
    artifacts: [
      newArtifact({
        id: "art",
        path: "artifacts/a.json",
        media_type: "application/json",
        sha256: SHA,
        size: 1,
        check_id: "tests.existing",
      }),
    ],
    report_completeness: {
      all_findings_included: true,
      truncated_evidence_items: 0,
      missing_artifacts: [],
      redaction: { applied: false, count: 0, reason: "secrets scan not run" },
    },
  });
  s.summary.network_isolation = IsolationNotProbed;
  s.summary.test_cases.passed = 4;
  s.summary.test_cases.failed = 1;
  finalize(s);
  return s;
}
