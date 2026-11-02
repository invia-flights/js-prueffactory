// Small, valid, finalized result sets for tests at seam B (hand-made results
// in, exit code and rendered reports out). Port of the Go package
// resultsettest.

import { finalize } from "../finalize.ts";
import {
  Applicable,
  BenchmarkNotRequested,
  FormatID,
  IsolationNotProbed,
  SchemaVersion,
  type Set,
  StatusCompleted,
} from "../types.ts";
import {
  newBenchmark,
  newContext,
  newExecution,
  newRun,
  newSet,
} from "../zero.ts";

/** SHA is a well-formed SHA-256 for fixtures. */
export const SHA = "ab".repeat(32);

/** fixtureTime is 2026-10-25T10:15:00Z, the start of every fixture Run. */
export const fixtureTime = Date.UTC(2026, 9, 25, 10, 15, 0);

/**
 * minimal returns a finalized, valid result set with one project Context, one
 * package Context and one completed syntax.parse execution without Findings.
 * Callers may change it and finalize it again.
 */
export function minimal(): Set {
  const s = newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    producer: { name: "js-prueffactory", version: "test", vcs_revision: null },
    run: newRun({
      id: "20261025T101500Z-demo-aaaa",
      command: "test",
      started_at: new Date(fixtureTime),
      finished_at: new Date(fixtureTime + 1000),
      duration_ms: 1000,
      budget_seconds: 1800,
      budget_source: "default",
      host: { os: "linux", arch: "amd64" },
      docker: {
        server_version: "29.4.0",
        api_version: "1.56",
        cpus: 4,
        memory_bytes: 2 ** 33,
      },
    }),
    source: {
      original_path: "/work/demo",
      snapshot_algorithm: "sorted-path-sha256-v1",
      snapshot_hash: SHA,
      file_count: 2,
      git: null,
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
      only: [],
      exclude: [],
      effective_checks: ["syntax.parse"],
      deselected_checks: [],
      prerequisites_run: [],
      is_standard_scope: true,
      fast: false,
    },
    contexts: [
      newContext({ id: "C-0001", kind: "project", path: "." }),
      newContext({ id: "C-0002", kind: "package", path: "." }),
    ],
    benchmark: newBenchmark({ status: BenchmarkNotRequested }),
    checks: [
      newExecution({
        id: "e1",
        check_id: "syntax.parse",
        family: "syntax",
        context_id: "C-0002",
        selected: true,
        applicability: Applicable,
        status: StatusCompleted,
      }),
    ],
    report_completeness: {
      all_findings_included: true,
      truncated_evidence_items: 0,
      missing_artifacts: [],
      redaction: {
        applied: false,
        count: 0,
        reason: "secrets scan not available",
      },
    },
  });
  s.summary.network_isolation = IsolationNotProbed;
  finalize(s);
  return s;
}
