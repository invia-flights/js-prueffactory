// Helpers for the engine's tests: a Run's configuration without Docker, fake
// Checks, planned executions built by hand, and Runs on small projects.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { TestContext } from "node:test";

import { type Entry, lookup } from "../checks/catalog.ts";
import type { Check, Result } from "../checks/check.ts";
import type { Selection } from "../checks/selection.ts";
import { Project, type Context } from "../discovery/discovery.ts";
import { background } from "../gocompat/context.ts";
import { minute } from "../gocompat/time.ts";
import { Reader } from "../gitstate/gitstate.ts";
import { Logger } from "../progress/progress.ts";
import { Applicable, type Applicability } from "../resultset/types.ts";
import { newContext } from "../resultset/zero.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { type Config, run, RunState } from "./engine.ts";
import type { ExecResult } from "./execution.ts";
import type { Planned } from "./plan.ts";
import { execute } from "./schedule.ts";
import { tempDir } from "../testkit/fs.testutil.ts";
import { writeFiles } from "../testkit/fs.testutil.ts";

export { tempDir };

export { writeFiles as writeTree };

/** Lines collects what a Logger writes. */
export class Lines extends Writable {
  text = "";
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    done();
  }
}

/** config is a Run's configuration without Docker: the secret scan cannot run. */
export function config(t: TestContext, fields: Partial<Config> = {}): Config {
  return {
    command: "test",
    original: "",
    reportDir: join(tempDir(t), "report"),
    excludeFromSnapshot: "",
    formats: { json: true, markdown: true },
    runID: "20261026T100000Z-demo-aaaa",
    start: new Date(),
    budget: 30n * minute,
    budgetSource: "default",
    selection: null,
    tempDir: tempDir(t),
    cacheDir: tempDir(t),
    docker: null,
    dockerInfo: null,
    git: new Reader(),
    log: new Logger(new Lines()),
    hardStop: null,
    ...fields,
  };
}

/** fakeCheck is a Check that applies everywhere and returns result. */
export function fakeCheck(
  result: Result | (() => Promise<Result>),
  more: Partial<Check> = {},
): Check {
  return {
    applicability: (): [Applicability, string] => [Applicable, ""],
    run: () =>
      typeof result === "function" ? result() : Promise.resolve(result),
    ...more,
  };
}

/** packageContext is a package Context with an ID and nothing else. */
export function contextWithID(id: string): Context {
  return { ...newContext({ id, kind: "package", path: "." }), package: null };
}

/** entry is the Catalog entry of id, or a made-up one for an unknown ID. */
export function entry(id: string): Entry {
  return (
    lookup(id) ?? {
      id,
      family: id.split(".")[0] ?? id,
      description: "",
      scope: "package",
      canFireGates: false,
      area: "none",
      status: "implemented",
      skippedByFast: false,
    }
  );
}

/** planned is a planned execution built by hand (Go tests build the struct). */
export function planned(fields: Partial<Planned> & { check: Check }): Planned {
  return {
    key: "x1",
    entry: entry("syntax.parse"),
    context: contextWithID("C-0002"),
    applicability: Applicable,
    reason: "",
    deselected: false,
    byFast: false,
    prerequisite: false,
    needs: [],
    waits: [],
    follows: [],
    orderedAfter: [],
    ...fields,
  };
}

/**
 * runState is the state of a Run whose Snapshot is an empty folder, for
 * calling the engine's steps directly.
 */
export function runState(
  t: TestContext,
  fields: Partial<Config> = {},
): RunState {
  const r = new RunState(config(t, fields));
  r.snap = {
    dir: tempDir(t),
    writeTar: () => Promise.resolve(),
  } as unknown as Snapshot;
  r.proj = new Project(r.snap.dir);
  return r;
}

/** executeOne runs one planned execution as the scheduler would. */
export function executeOne(
  r: RunState,
  p: Planned,
  signal: AbortSignal = background(),
  budget: AbortSignal = signal,
): Promise<ExecResult> {
  return execute(r, signal, budget, p, false);
}

/** ReportExec is an execution of report.json, as far as the tests read it. */
export interface ReportExec {
  check_id: string;
  selected: boolean;
  status: string;
  applicability: string;
  reason_code: string | null;
}

/** ReportJSON is report.json as parsed JSON. */
export type ReportJSON = Record<string, unknown> & {
  checks: ReportExec[];
  selection: Record<string, unknown>;
  summary: Record<string, Record<string, unknown>>;
  report_completeness: Record<string, Record<string, unknown>>;
  run: Record<string, unknown>;
  limitations: Record<string, unknown>[];
  findings: Record<string, unknown>[];
};

/**
 * runProject writes the files as a project, runs the engine on it without
 * Docker and returns the exit code, report.json and the progress lines.
 */
export async function runProject(
  t: TestContext,
  files: Record<string, string>,
  selection: Selection | null,
  fields: Partial<Config> = {},
): Promise<{
  exitCode: number;
  report: ReportJSON;
  reportDir: string;
  log: string;
}> {
  const project = join(tempDir(t), "demo");
  writeFiles(project, files);
  const lines = new Lines();
  const cfg = config(t, {
    original: project,
    selection,
    log: new Logger(lines),
    ...fields,
  });
  const res = await run(background(), cfg);
  const report = JSON.parse(
    readFileSync(join(cfg.reportDir, "report.json"), "utf8"),
  ) as ReportJSON;
  return {
    exitCode: res.exitCode,
    report,
    reportDir: cfg.reportDir,
    log: lines.text,
  };
}

/** selection is a hand-built Selection; name only what the test needs. */
export function selection(fields: Partial<Selection>): Selection {
  return {
    only: [],
    exclude: [],
    effective: [],
    deselected: [],
    isStandardScope: false,
    fast: false,
    deselectedByFast: [],
    ...fields,
  };
}
