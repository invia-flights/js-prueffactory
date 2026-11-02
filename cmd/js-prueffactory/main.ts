// Command js-prueffactory checks a JavaScript project and reports the results.
// This file only wires the real process into cli.main; bin/js-prueffactory.js
// loads it once the Node version is known to be new enough.
import process from "node:process";

import { main } from "../../internal/cli/cli.ts";
import { withInterrupts } from "../../internal/cli/interrupt.ts";

// The first SIGINT or SIGTERM cancels the Run, which cleans up and still
// writes a Report. The second one skips the Report.
const interrupts = withInterrupts();
const onSignal = (): void => {
  interrupts.interrupt();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

const code = await main(
  process.argv.slice(2),
  (name) => process.env[name] ?? "",
  process.stdout,
  process.stderr,
  interrupts.signal,
);
interrupts.stop();
process.off("SIGINT", onSignal);
process.off("SIGTERM", onSignal);
// exitCode instead of process.exit, so that output still queued for a pipe
// is written before the process ends.
process.exitCode = code;
