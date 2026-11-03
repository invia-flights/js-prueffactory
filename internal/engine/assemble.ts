// Building the result set from what the Run collected (Go: assemble.go).
import { readFileSync } from "node:fs";

import { CatalogVersion, ExecutionProfile } from "../checks/catalog.ts";
import type { Selection } from "../checks/selection.ts";
import type { Project } from "../discovery/discovery.ts";
import { second } from "../gocompat/time.ts";
import {
  BenchmarkNotRequested,
  type Context,
  IsolationNotProbed,
  type Producer,
  RunCancelled,
  RunCompleted,
  type Set as ResultSet,
} from "../resultset/types.ts";
import { FormatID, SchemaVersion } from "../resultset/types.ts";
import { newSet } from "../resultset/zero.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { version as toolsetVersion } from "../toolset/all.ts";
import type { RunState } from "./engine.ts";
import { prerequisitesRun } from "./prerequisites.ts";
import { redactSet } from "./redaction.ts";
import { registryDataDate } from "./registrydate.ts";
import { reportServices } from "./services.ts";
import { markFileClasses, probedTestFilesOf } from "./testcode.ts";
import { recordContextTools } from "./tools.ts";

let build: Producer | undefined;

/**
 * producer names the build from the package's own package.json: its version,
 * and as vcs_revision the commit the packaging step stamped into it (Go read
 * it from the binary's build information). Sources run directly carry no
 * stamp, so vcs_revision is null there.
 */
export function producer(): Producer {
  if (build === undefined) {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown; vcsRevision?: unknown };
    build = {
      name: "js-prueffactory",
      version: String(manifest.version),
      vcs_revision:
        typeof manifest.vcsRevision === "string" && manifest.vcsRevision !== ""
          ? manifest.vcsRevision
          : null,
    };
  }
  return { ...build };
}

// Go's runtime.GOOS and runtime.GOARCH for Node's names.
const goArch: Readonly<Record<string, string>> = {
  x64: "amd64",
  ia32: "386",
  arm64: "arm64",
  arm: "arm",
};

/** contextOf is the Report's part of a discovered Context, as a copy. */
function contextOf(c: Context): Context {
  return {
    id: c.id,
    kind: c.kind,
    path: c.path,
    node: c.node,
    npm_version: c.npm_version,
    tools: [...c.tools],
    limits: c.limits,
  };
}

/**
 * assemble builds the result set from what the Run collected. Executions,
 * Findings and metrics still carry temporary keys; finalize replaces them.
 */
export function assemble(
  r: RunState,
  signal: AbortSignal,
  snap: Snapshot,
  proj: Project,
  sel: Selection,
): ResultSet {
  const finished = new Date();
  const cfg = r.cfg;

  const s = newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    producer: producer(),
  });
  s.run.id = cfg.runID;
  s.run.command = cfg.command;
  s.run.started_at = cfg.start;
  s.run.finished_at = finished;
  s.run.duration_ms = finished.getTime() - cfg.start.getTime();
  s.run.budget_seconds = Number(cfg.budget / second);
  s.run.budget_source = cfg.budgetSource;
  s.run.status = RunCompleted;
  s.run.host = {
    os: process.platform,
    arch: goArch[process.arch] ?? process.arch,
  };
  s.source = {
    original_path: cfg.original,
    snapshot_algorithm: snap.algorithm,
    snapshot_hash: snap.hash,
    file_count: snap.fileCount,
    git: r.git,
    original_unchanged: !r.unverified && r.changed.length === 0,
    changed_paths: r.changed,
    excluded_paths: snap.excluded,
  };
  s.profiles = {
    catalog_version: CatalogVersion,
    execution_profile: ExecutionProfile,
    benchmark_profile: null,
    toolset_version: toolsetVersion(),
  };
  s.selection = {
    only: sel.only,
    exclude: sel.exclude,
    effective_checks: sel.effective,
    deselected_checks: sel.deselected,
    prerequisites_run: prerequisitesRun(r),
    is_standard_scope: sel.isStandardScope,
    fast: sel.fast,
  };
  s.summary.network_isolation = IsolationNotProbed;
  s.benchmark.status = BenchmarkNotRequested;
  s.report_completeness.all_findings_included = true;
  if (cfg.dockerInfo !== null) {
    s.run.docker = {
      server_version: cfg.dockerInfo.serverVersion,
      api_version: cfg.dockerInfo.apiVersion,
      cpus: cfg.dockerInfo.cpus,
      memory_bytes: cfg.dockerInfo.memoryBytes,
    };
  }
  if (r.isolation !== "") {
    s.summary.network_isolation = r.isolation;
  }
  if (r.cancelled || signal.aborted) {
    s.run.status = RunCancelled;
  }
  s.contexts = proj.contexts.map(contextOf);
  s.run.registry_data_date = registryDataDate(r.results);
  s.limitations.push(...r.snapLimits, ...r.limitations);
  for (const res of r.results) {
    s.checks.push(res.exec);
    s.findings.push(...res.findings);
    s.metrics.push(...res.metrics);
    s.limitations.push(...res.limitations);
    s.artifacts.push(...res.artifacts);
    s.test_cases.push(...res.testCases);
    const inv = res.inventory;
    if (inv !== null) {
      s.inventory.suppressions.push(...inv.suppressions);
      s.inventory.file_hashes.push(...inv.file_hashes);
      s.inventory.size.push(...inv.size);
      s.inventory.tests.push(...inv.tests);
      s.inventory.test_suites.push(...inv.test_suites);
      s.inventory.test_files.push(...inv.test_files);
      s.inventory.moved_test_files.push(...inv.moved_test_files);
    }
  }
  markFileClasses(proj, probedTestFilesOf(r, proj), s.findings);
  const [services, serviceLimits] = reportServices(r.results, proj);
  s.services = services;
  s.limitations.push(...serviceLimits);
  recordContextTools(s.contexts, r.results);
  redactSet(r, s);
  return s;
}
