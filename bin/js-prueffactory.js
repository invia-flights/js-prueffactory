#!/usr/bin/env node
// The js-prueffactory command. Plain JavaScript with no imports, so that a
// Node too old for the tool still runs this file and gets a plain message
// instead of a loader or syntax error. internal/cli/cli.ts makes the same check
// with the same message; keep both in step.
const requiredNodeMajor = 24;

if (Number(process.versions.node.split(".")[0]) < requiredNodeMajor) {
  process.stderr.write(
    `js-prueffactory: needs Node ${String(requiredNodeMajor)} or newer, this is Node ${process.versions.node}\n`,
  );
  process.exitCode = 3;
} else {
  await import("../cmd/js-prueffactory/main.ts");
}
