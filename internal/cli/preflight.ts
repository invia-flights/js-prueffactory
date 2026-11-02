// The Docker setup check of `test` and `benchmark` (cli.go, runTest: "From
// here on Docker is needed"). It runs after the arguments are read and before
// any file is copied: a missing docker CLI, an unreachable daemon or one too
// old fail the Run with exit code 3 and Go's message; an interrupt during the
// check exits 130.
import type { Writable } from "node:stream";

import { Driver, env, type Info, locate } from "../docker/driver.ts";
import { ExitInternalError, ExitInterrupted } from "../resultset/exitcode.ts";
import { errorMessage } from "../gocompat/errors.ts";

export interface DockerSetup {
  // base is the Driver without a Run scope; withScope gives the Run's.
  readonly base: Driver;
  readonly info: Info;
}

// preflightDocker returns the Driver and the daemon's facts, or, after writing
// the message to stderr, the exit code the Run ends with.
export async function preflightDocker(
  getenv: (name: string) => string,
  signal: AbortSignal,
  stderr: Writable,
): Promise<DockerSetup | number> {
  const fail = (err: unknown): number => {
    stderr.write(`js-prueffactory: ${errorMessage(err)}\n`);
    return ExitInternalError;
  };
  let exe: string;
  try {
    exe = locate(getenv);
  } catch (err) {
    return fail(err);
  }
  const base = new Driver(exe, env(getenv));
  try {
    return { base, info: await base.preflight(signal) };
  } catch (err) {
    if (signal.aborted) {
      stderr.write("js-prueffactory: interrupted\n");
      return ExitInterrupted;
    }
    return fail(err);
  }
}
