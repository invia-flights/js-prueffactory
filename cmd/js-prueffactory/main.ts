// Command js-prueffactory checks a JavaScript project and reports the results.
// This file only wires the real process into cli.main; bin/js-prueffactory.js
// loads it once the Node version is known to be new enough.
import process from "node:process";

import { main } from "../../internal/cli/cli.ts";

// The interrupt handling of Go's cli.WithInterrupts (first SIGINT or SIGTERM
// cancels the Run, the second skips the Report) arrives with the engine, in
// ticket 12 of the port. Until then nothing aborts this signal.
const interrupts = new AbortController();

const code = await main(
  process.argv.slice(2),
  (name) => process.env[name] ?? "",
  process.stdout,
  process.stderr,
  interrupts.signal,
);
// exitCode instead of process.exit, so that output still queued for a pipe
// is written before the process ends.
process.exitCode = code;
