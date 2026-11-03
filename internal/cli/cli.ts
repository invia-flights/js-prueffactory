// Package cli is the command front end and test seam A: one in-process entry
// point that takes the arguments, an environment lookup, stdout, stderr and a
// cancellation signal, and returns the exit code. cmd/js-prueffactory/main.ts
// only wires the real process into it.
import { hostname } from "node:os";
import type { Writable } from "node:stream";

import type { Selection } from "../checks/selection.ts";
import { base } from "../gocompat/path.ts";
import type { Driver } from "../docker/driver.ts";
import { ErrAborted, run as runEngine } from "../engine/engine.ts";
import { tempDir } from "../gocompat/filepath.ts";
import { quote } from "../gocompat/fmt.ts";
import {
  type Duration,
  durationString,
  milliseconds,
  minute,
} from "../gocompat/time.ts";
import { fromEnv } from "../gitstate/gitstate.ts";
import { Logger } from "../progress/progress.ts";
import {
  ExitInternalError,
  ExitInterrupted,
  ExitOK,
} from "../resultset/exitcode.ts";
import { newRunID, randomSuffix } from "../runid/runid.ts";
import { cleanOtherVersions } from "../toolvolume/toolvolume.ts";
import { resolveBudget } from "./budget.ts";
import { cacheDir } from "./cachedir.ts";
import { hardStop } from "./interrupt.ts";
import { ErrHelp, type Formats, type Options, parse } from "./options.ts";
import { type OutputPlan, resolveOriginal, resolveOutput } from "./paths.ts";
import { type DockerSetup, preflightDocker } from "./preflight.ts";
import { runListChecks } from "./selection.ts";
import { errorMessage } from "../gocompat/errors.ts";

const usage = `usage:
  js-prueffactory test <path> [--format json|markdown|json,markdown] [--output-dir <dir>]
                              [--budget <duration>] [--fast]
                              [--only <checks>] [--exclude <checks>]
  js-prueffactory benchmark <path> [the same flags as test]
  js-prueffactory list-checks <path> [--format markdown|json] [--fast] [--only <checks>] [--exclude <checks>]

Checks the JavaScript project in <path> without modifying it and writes
report.json and report.md into a new report folder. The folder is printed as
the only line on stdout; progress goes to stderr. benchmark runs the same Checks
and adds a 0 to 100 score, labelled uncalibrated, and a Verdict; the Verdict
never changes the exit code.

--only and --exclude take comma-separated Check IDs or families (the part of an
ID before the first dot) and may repeat. list-checks shows the Catalog and what
applies to <path> without Docker and without writing files.

The default Budget is 2 hours. --fast skips the slow Checks (list-checks shows
which) and makes the default Budget 30 minutes; an explicit --budget always wins.

exit codes: 0 all selected applicable Checks completed, no Gate fired;
1 a Gate fired; 2 no Gate fired but a Check did not complete; 3 usage error,
Docker unreachable or internal error; 130 interrupted.
`;

// The oldest Node major the tool runs on. bin/js-prueffactory.js repeats the
// check for a Node too old to load these sources at all.
const requiredNodeMajor = 24;

// main runs js-prueffactory and returns the exit code. args do not include
// the program name. getenv returns "" for an unset name, like Go's os.Getenv.
// nodeVersion is the running Node's version; tests pass another one.
export function main(
  args: readonly string[],
  getenv: (name: string) => string,
  stdout: Writable,
  stderr: Writable,
  signal: AbortSignal,
  nodeVersion: string = process.versions.node,
): Promise<number> {
  if (Number(nodeVersion.split(".")[0]) < requiredNodeMajor) {
    stderr.write(
      `js-prueffactory: needs Node ${String(requiredNodeMajor)} or newer, this is Node ${nodeVersion}\n`,
    );
    return Promise.resolve(ExitInternalError);
  }

  const [command, ...rest] = args;
  if (command === undefined) {
    stderr.write("js-prueffactory: no command given\n" + usage);
    return Promise.resolve(ExitInternalError);
  }
  switch (command) {
    case "-h":
    case "--help":
    case "help":
      stdout.write(usage);
      return Promise.resolve(ExitOK);
    case "test":
    case "benchmark":
      // benchmark runs exactly the Checks test runs, with the same flags and
      // the same exit codes, and adds the score to the Report.
      return runTest(command, rest, getenv, stdout, stderr, signal);
    case "list-checks":
      return Promise.resolve(
        runListChecksCommand(command, rest, stdout, stderr),
      );
    default:
      stderr.write(
        `js-prueffactory: unknown command ${quote(command)}\n${usage}`,
      );
      return Promise.resolve(ExitInternalError);
  }
}

// parseOrExit parses the arguments, or writes the usage text (for -h) or the
// error and gives the exit code.
function parseOrExit(
  command: string,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): Options | number {
  try {
    return parse(command, args);
  } catch (err) {
    if (err === ErrHelp) {
      stdout.write(usage);
      return ExitOK;
    }
    stderr.write(`js-prueffactory: ${errorMessage(err)}\n`);
    return ExitInternalError;
  }
}

async function runTest(
  command: string,
  args: readonly string[],
  getenv: (name: string) => string,
  stdout: Writable,
  stderr: Writable,
  signal: AbortSignal,
): Promise<number> {
  const fail = (err: unknown): number => {
    stderr.write(`js-prueffactory: ${errorMessage(err)}\n`);
    return ExitInternalError;
  };

  const opts = parseOrExit(command, args, stdout, stderr);
  if (typeof opts === "number") {
    return opts;
  }

  const log = new Logger(stderr);
  let budget: { budget: Duration; source: string };
  let original: string;
  let id: string;
  let out: OutputPlan;
  const start = new Date();
  try {
    budget = resolveBudget(opts.budgetFlag, opts.fast, getenv, (msg) => {
      log.print(msg);
    });
    log.print(`budget ${durationString(budget.budget)} (${budget.source})`);
    original = resolveOriginal(opts.path);
    id = newRunID(start, base(original), randomSuffix);
    out = resolveOutput(opts.outputDir, original, id, getenv);
  } catch (err) {
    return fail(err);
  }

  // From here on Docker is needed. Check it before any file is copied.
  const docker = await preflightDocker(getenv, signal, stderr);
  if (typeof docker === "number") {
    return docker;
  }
  return startRun(
    {
      command,
      original,
      reportDir: out.dir,
      excludeFromSnapshot: out.excludeFromSnapshot,
      formats: opts.formats,
      selection: opts.selection,
      runID: id,
      start,
      budget: budget.budget,
      budgetSource: budget.source,
      docker,
    },
    { getenv, stdout, stderr, signal, log },
  );
}

/** RunPlan is everything the command line settled before a Run starts. */
export interface RunPlan {
  command: string;
  original: string;
  reportDir: string;
  excludeFromSnapshot: string;
  formats: Formats;
  selection: Selection | null;
  runID: string;
  start: Date;
  budget: Duration;
  budgetSource: string;
  docker: DockerSetup;
}

// The process around a Run: where its output goes and what ends it.
interface RunIO {
  getenv: (name: string) => string;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  log: Logger;
}

/**
 * interrupted is the exit path of a Run that was cancelled before it had a
 * Report to write, or that was stopped by a second interrupt.
 */
function interrupted(stderr: Writable): number {
  stderr.write("js-prueffactory: interrupted\n");
  return ExitInterrupted;
}

// startRun sweeps what dead Runs left in Docker, removes the toolset volumes
// of other toolset versions and runs the engine (Go: the rest of runTest).
async function startRun(plan: RunPlan, io: RunIO): Promise<number> {
  const { getenv, stdout, stderr, signal, log } = io;
  const host = hostname();
  const scoped = plan.docker.base.withScope({
    runID: plan.runID,
    host,
    pid: process.pid,
    deadline: new Date(
      plan.start.getTime() + milliseconds(plan.budget + 10n * minute),
    ),
  });
  await sweepLeftovers(signal, scoped, host, log);
  if (signal.aborted) {
    return interrupted(stderr);
  }
  // Toolset volumes of other toolset versions go at the start of every Run.
  await cleanOtherVersions(signal, {
    docker: scoped,
    cacheDir: cacheDir(getenv),
    logf: (line) => {
      log.print(line);
    },
  });
  const tmp = getenv("TMPDIR") || tempDir();
  let res;
  try {
    res = await runEngine(signal, {
      command: plan.command,
      original: plan.original,
      reportDir: plan.reportDir,
      excludeFromSnapshot: plan.excludeFromSnapshot,
      formats: plan.formats,
      selection: plan.selection,
      runID: plan.runID,
      start: plan.start,
      budget: plan.budget,
      budgetSource: plan.budgetSource,
      tempDir: tmp,
      cacheDir: cacheDir(getenv),
      git: fromEnv(getenv),
      docker: scoped,
      dockerInfo: plan.docker.info,
      log,
      hardStop: hardStop(signal),
    });
  } catch (err) {
    if (err === ErrAborted) {
      return interrupted(stderr);
    }
    stderr.write(`js-prueffactory: ${errorMessage(err)}\n`);
    return ExitInternalError;
  }
  stdout.write(res.reportDir + "\n");
  return res.exitCode;
}

/**
 * sweepLeftovers removes what dead Runs left in Docker. It never fails the
 * Run: a sweep that cannot finish only warns.
 */
async function sweepLeftovers(
  signal: AbortSignal,
  d: Driver,
  host: string,
  log: Logger,
): Promise<void> {
  let removed: readonly string[] = [];
  let error: unknown;
  try {
    const res = await d.sweepLeftovers(signal, new Date(), host);
    removed = res.removed;
    error = res.error;
  } catch (err) {
    error = err;
  }
  if (removed.length > 0) {
    log.print(
      `removed ${String(removed.length)} leftover Docker resource(s) of dead Runs`,
    );
  }
  if (error !== undefined && !signal.aborted) {
    log.print(
      `warning: could not sweep every leftover of dead Runs: ${errorMessage(error)}`,
    );
  }
}

// runListChecksCommand parses the arguments of list-checks and prints the
// listing.
function runListChecksCommand(
  command: string,
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
): number {
  const opts = parseOrExit(command, args, stdout, stderr);
  if (typeof opts === "number") {
    return opts;
  }
  return runListChecks(opts, stdout, stderr);
}
