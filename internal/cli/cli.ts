// Package cli is the command front end and test seam A: one in-process entry
// point that takes the arguments, an environment lookup, stdout, stderr and a
// cancellation signal, and returns the exit code. cmd/js-prueffactory/main.ts
// only wires the real process into it.
import type { Writable } from "node:stream";

import type { Selection } from "../checks/selection.ts";
import { base } from "../gocompat/filepath.ts";
import { quote } from "../gocompat/fmt.ts";
import { type Duration, durationString } from "../gocompat/time.ts";
import { Logger } from "../progress/progress.ts";
import { ExitInternalError, ExitOK } from "../resultset/exitcode.ts";
import { newRunID, randomSuffix } from "../runid/runid.ts";
import { resolveBudget } from "./budget.ts";
import { ErrHelp, type Formats, type Options, parse } from "./options.ts";
import { type OutputPlan, resolveOriginal, resolveOutput } from "./paths.ts";
import { type DockerSetup, preflightDocker } from "./preflight.ts";

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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    stderr.write(`js-prueffactory: ${message(err)}\n`);
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
    stderr.write(`js-prueffactory: ${message(err)}\n`);
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
    stderr,
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

// startRun sweeps leftovers, cleans old toolset volumes and runs the engine
// (Go: the rest of runTest). The engine is ported in ticket 12; until then the
// TypeScript build stops here, after every check of the command line passed.
function startRun(plan: RunPlan, stderr: Writable): Promise<number> {
  stderr.write(
    `js-prueffactory: the TypeScript build does not run ${plan.command} yet\n`,
  );
  return Promise.resolve(ExitInternalError);
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
  try {
    resolveOriginal(opts.path);
  } catch (err) {
    stderr.write(`js-prueffactory: ${message(err)}\n`);
    return ExitInternalError;
  }
  // Discovery and the listing are ported in tickets 09 and 10.
  stderr.write(
    "js-prueffactory: the TypeScript build does not run list-checks yet\n",
  );
  return ExitInternalError;
}
