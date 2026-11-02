// The installed command, started as a process: the launcher, the process
// wiring and main together.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const command = fileURLToPath(
  new URL("../../bin/js-prueffactory.js", import.meta.url),
);

const recorded = JSON.parse(
  readFileSync(
    new URL("../../internal/cli/testdata/go-usage.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: { args: string[]; stdout: string; stderr: string; exitCode: number }[];
};

for (const want of recorded.cases) {
  test(`the command prints what the Go build prints: ${want.args.join(" ") || "(no arguments)"}`, () => {
    const got = spawnSync(process.execPath, [command, ...want.args], {
      encoding: "utf8",
    });
    assert.equal(got.status, want.exitCode);
    assert.equal(got.stdout, want.stdout);
    assert.equal(got.stderr, want.stderr);
  });
}
