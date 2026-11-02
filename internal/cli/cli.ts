// Package cli is the command front end and test seam A: one in-process entry
// point that takes the arguments, an environment lookup, stdout, stderr and a
// cancellation signal, and returns the exit code. cmd/js-prueffactory/main.ts
// only wires the real process into it.
import type { Writable } from "node:stream";

import { ExitInternalError, ExitOK } from "../resultset/exitcode.ts";

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
  // getenv and signal are used once test and benchmark are ported.
  return Promise.resolve(run(args, stdout, stderr, nodeVersion));
}

function run(
  args: readonly string[],
  stdout: Writable,
  stderr: Writable,
  nodeVersion: string,
): number {
  if (Number(nodeVersion.split(".")[0]) < requiredNodeMajor) {
    stderr.write(
      `js-prueffactory: needs Node ${String(requiredNodeMajor)} or newer, this is Node ${nodeVersion}\n`,
    );
    return ExitInternalError;
  }

  const [command] = args;
  if (command === undefined) {
    stderr.write("js-prueffactory: no command given\n" + usage);
    return ExitInternalError;
  }
  switch (command) {
    case "-h":
    case "--help":
    case "help":
      stdout.write(usage);
      return ExitOK;
    default:
      // test, benchmark, list-checks and the unknown-command error come with
      // ticket 07 of the port.
      stderr.write(
        `js-prueffactory: the TypeScript build does not run ${command} yet\n`,
      );
      return ExitInternalError;
  }
}
