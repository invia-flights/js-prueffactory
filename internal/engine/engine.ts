// Package engine performs a Run: it takes the Snapshot, discovers the
// project, plans the Check executions, prepares Docker, runs the Checks,
// proves the Original is unchanged, cleans up and writes the Report.
//
// The work is split over files by phase, as in Go: source.ts (Snapshot and
// the final re-hash), plan.ts (Selection and the list of executions),
// docker.ts (Preparation phase), schedule.ts and pool.ts (running the
// executions), assemble.ts (building the result set), redaction.ts.
//
// Go's three contexts are AbortSignals here (gocompat/context.ts): the Run's
// signal ends on the first interrupt, the Budget's at the start of the
// reserve, an execution's at its time limit. Why an execution ended is read
// from which of them ended (budget.ts endReason).
import { rmSync } from "node:fs";

import { apply as applyBenchmark } from "../benchmark/benchmark.ts";
import "../checks/all.ts";
import { catalog } from "../checks/catalog.ts";
import { resolve, type Selection } from "../checks/selection.ts";
import { Shared } from "../checks/shared.ts";
import { discover, type Project } from "../discovery/discovery.ts";
import type { Driver, Info } from "../docker/driver.ts";
import { withCancel, done } from "../gocompat/context.ts";
import type { Duration } from "../gocompat/time.ts";
import type { Reader } from "../gitstate/gitstate.ts";
import type { Logger } from "../progress/progress.ts";
import { newRedactor, type Redactor } from "../redact/redact.ts";
import { finalize } from "../resultset/resultset.ts";
import type {
  GitState,
  Limitation,
  Set as ResultSet,
} from "../resultset/types.ts";
import type { Snapshot } from "../snapshot/snapshot.ts";
import { type Formats, InvalidReportError, write } from "../writer/writer.ts";
import { assemble } from "./assemble.ts";
import type { ExecResult } from "./execution.ts";
import { plan, type Planned } from "./plan.ts";
import {
  collectNpmrcSecrets,
  collectServiceSecrets,
  explainInvalid,
  type SecretScan,
} from "./redaction.ts";
import { executeAll } from "./schedule.ts";
import { takeSnapshot, verifyOriginal } from "./source.ts";

/** Config is everything a Run needs. The front end validates it first. */
export interface Config {
  /** command is "test" or "benchmark". */
  command: string;
  /** original is the absolute, symlink-resolved project folder. */
  original: string;
  /** reportDir is the absolute folder the Report goes into. */
  reportDir: string;
  /** excludeFromSnapshot is an explicit report folder inside the Original, or "". */
  excludeFromSnapshot: string;
  formats: Formats;
  runID: string;
  start: Date;
  budget: Duration;
  /** budgetSource is "default", "fast_default", "flag" or "ci_job_timeout". */
  budgetSource: string;
  /** selection says which Checks are selected; null means every implemented Check. */
  selection: Selection | null;
  /** tempDir holds the host-side copy of the Snapshot for the length of the Run. */
  tempDir: string;
  /**
   * cacheDir is the host folder of js-prueffactory's caches. It holds the
   * lock that protects the shared Docker cache volumes.
   */
  cacheDir: string;
  /** docker creates resources owned by this Run; dockerInfo is the daemon's answer to the preflight. */
  docker: Driver | null;
  dockerInfo: Info | null;
  /** git reads the git state of the Original; a Reader without exe stands for a host without git. */
  git: Reader;
  log: Logger;
  /**
   * hardStop, when it ends, is the second interrupt: the Run skips the
   * Report, cleans up at once and throws ErrAborted. May be null.
   */
  hardStop: AbortSignal | null;
}

/** ErrAborted is thrown when hardStop ended. No Report was written. */
export const ErrAborted = new Error(
  "the Run was stopped by a second interrupt; no Report was written",
);

/**
 * hardStopGrace is how long a hard-stopped Run waits for its own work to
 * notice the cancellation before it cleans up a last time.
 */
export const hardStopGraceMs = 10_000;

/** Result is the outcome of a Run that produced a Report. */
export interface Result {
  exitCode: number;
  reportDir: string;
}

/** AdvisoryDB is what the Preparation phase made of the advisory database. */
export interface AdvisoryDB {
  volume: string;
  date: Date | null;
  warning: string;
  /** err is why the database is not available, when it is not. */
  err: string;
}

/** RunState holds the state of one Run (Go: the run struct). */
export class RunState {
  readonly cfg: Config;
  readonly log: Logger;

  snap: Snapshot | null = null;
  /** git is null without .git or when it cannot be read. */
  git: GitState | null = null;
  tmpDir = "";
  snapLimits: Limitation[] = [];
  /** changed are the paths of the Original that changed during the Run. */
  changed: string[] = [];
  /** unverified says that the final re-hash itself failed. */
  unverified = false;

  proj: Project | null = null;
  planned: Planned[] = [];
  /** shared holds results that Checks of the Run share. */
  shared = new Shared();
  /** selection is the Selection the Run resolved. */
  selection: Selection | null = null;

  // Docker state of the Execution phase.
  volume = "";
  network = "";
  dockerReady = false;
  /** workVolume holds the Working copy, when a Check uses it. */
  workVolume = "";
  /** isolation is the answer of the network isolation probe, or "" while it has not run. */
  isolation = "";

  /** finished remembers how executions ended, for those that wait for them. */
  readonly finished = new Map<Planned, ExecResult>();

  /** The toolset volume with the pinned npm tools, or the reason it is not available. */
  toolsetVolume = "";
  toolsetErr = "";
  advisory: AdvisoryDB = { volume: "", date: null, warning: "", err: "" };
  /** The volume with the Kubernetes schemas, or the reason it is not available. */
  kubernetesSchemas = { volume: "", err: "" };

  results: ExecResult[] = [];
  /**
   * redactor holds the secret values found in the Run, in memory only. scan
   * records how the secret scan went, prerequisites the Checks that ran
   * without being selected.
   */
  readonly redactor: Redactor = newRedactor();
  scan: SecretScan = { seen: false, status: "not_started", reason: "" };
  /** envLeft are the names of .env and Service variables whose values the EnvRule left readable. */
  envLeft: string[] = [];
  prerequisites: string[] = [];
  /** limitations collects Run-level Limitations next to those of Checks. */
  limitations: Limitation[] = [];
  cancelled = false;

  #cleaned = false;
  #aborted = false;
  // #removing is the removal in progress: one at a time.
  #removing: Promise<void> = Promise.resolve();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.log = cfg.log;
  }

  /** abort records the hard stop, after which no Report is written. */
  abort(): void {
    this.#aborted = true;
  }

  get aborted(): boolean {
    return this.#aborted;
  }

  /** finish remembers how an execution ended, for the executions that wait for it. */
  finish(p: Planned, res: ExecResult): void {
    this.finished.set(p, res);
  }

  finishedResult(p: Planned): ExecResult | undefined {
    return this.finished.get(p);
  }

  /**
   * redactText is what Checks use to remove the Run's known secrets from a
   * text before it is cut or reshaped.
   */
  readonly redactText = (s: string): string => this.redactor.string(s)[0];

  /**
   * cleanup removes every Docker resource of the Run and the host-side copy.
   * Only the first call does anything.
   */
  async cleanup(): Promise<void> {
    if (this.#cleaned) {
      return;
    }
    this.#cleaned = true;
    await this.cleanupNow();
  }

  /**
   * cleanupNow does the removal whether or not cleanup ran before. Removing
   * what is already gone is harmless, which makes it the tool of the hard
   * stop.
   */
  cleanupNow(): Promise<void> {
    const next = this.#removing.then(async () => {
      if (this.cfg.docker !== null) {
        try {
          await this.cfg.docker.removeRunResources();
        } catch (err) {
          this.log.print(
            `warning: could not remove every Docker resource of this Run: ${message(err)}`,
          );
        }
      }
      // The Snapshot copy lives inside tmpDir.
      if (this.tmpDir !== "") {
        try {
          rmSync(this.tmpDir, { recursive: true, force: true });
        } catch {
          // as Go's os.RemoveAll, whose error the engine ignores
        }
      }
    });
    this.#removing = next;
    return next;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * run performs the Run. signal ends on the first interrupt: the Run stops
 * its Checks, cleans up and still writes a Report marked as cancelled. A
 * thrown error means no valid Report was written and the caller exits with
 * 3; ErrAborted means a second interrupt stopped the Run.
 */
export async function run(signal: AbortSignal, cfg: Config): Promise<Result> {
  const r = new RunState(cfg);
  const hardStop = cfg.hardStop;
  if (hardStop === null) {
    return perform(r, signal);
  }
  const w = withCancel(signal);
  type Outcome = { res: Result } | { err: unknown };
  const performing: Promise<Outcome> = perform(r, w.signal).then(
    (res) => ({ res }),
    (err: unknown) => ({ err }),
  );
  try {
    const first = await Promise.race([
      performing,
      done(hardStop).then(() => null),
    ]);
    if (first !== null) {
      if ("err" in first) {
        throw first.err;
      }
      return first.res;
    }
    r.log.print("second interrupt: skipping the Report and cleaning up");
    r.abort();
    w.cancel();
    await r.cleanupNow();
    // The Run's own work may still create or hold something until it sees
    // the cancellation, so wait for it briefly and clean up once more.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      performing,
      new Promise((resolve) => {
        timer = setTimeout(resolve, hardStopGraceMs);
      }),
    ]);
    clearTimeout(timer);
    await r.cleanupNow();
    throw ErrAborted;
  } finally {
    w.cancel();
  }
}

/** perform is the Run itself, without the hard-stop watch. */
async function perform(r: RunState, signal: AbortSignal): Promise<Result> {
  const cfg = r.cfg;
  r.log.print(`run ${cfg.runID} started on ${cfg.original}`);

  // Whatever happens below, nothing of this Run stays behind. cleanup runs
  // once, and the normal path calls it before the Report is written.
  try {
    const snap = await takeSnapshot(r, signal);
    const proj = discover(snap.dir);
    r.proj = proj;
    // Known before any container runs, so that Checks can redact what a
    // Service logs before they put it in a reason.
    collectServiceSecrets(r, proj);
    r.log.print(
      `discovered ${String(proj.packages.length)} package(s) and ${String(proj.files.length)} file(s)`,
    );

    const sel = cfg.selection ?? resolve(catalog(), [], []);
    r.selection = sel;
    r.planned = plan(proj, sel);
    r.shared = new Shared();
    await executeAll(r, signal);
    collectNpmrcSecrets(r);
    verifyOriginal(r, snap);
    await r.cleanup();

    const set = assemble(r, signal, snap, proj, sel);
    finalize(set);
    if (cfg.command === "benchmark") {
      // The score reads the finished Report and changes nothing in it but
      // the benchmark section. The exit code stays what the Checks decided.
      applyBenchmark(set);
    }
    writeReport(r, set);
    r.log.print(`report written to ${cfg.reportDir}`);
    return { exitCode: set.run.exit_code, reportDir: cfg.reportDir };
  } finally {
    await r.cleanup();
  }
}

/** writeReport writes the Report unless the Run was hard-stopped. */
function writeReport(r: RunState, set: ResultSet): void {
  if (r.aborted) {
    throw ErrAborted;
  }
  try {
    write(r.cfg.reportDir, set, r.cfg.formats);
  } catch (err) {
    if (err instanceof InvalidReportError) {
      explainInvalid(r, err);
    }
    throw err;
  }
}
