import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { runMain } from "./cli.testutil.ts";

interface RecordedCall {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Output of the frozen Go build for the usage calls (see recordedFrom).
const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-usage.json", import.meta.url), "utf8"),
) as { recordedFrom: string; cases: RecordedCall[] };

describe("usage text matches the Go build", () => {
  for (const want of recorded.cases) {
    test(`js-prueffactory ${want.args.join(" ") || "(no arguments)"}`, async () => {
      const got = await runMain(want.args);
      assert.equal(got.exitCode, want.exitCode);
      assert.deepEqual(got.stdout, Buffer.from(want.stdout, "utf8"));
      assert.deepEqual(got.stderr, Buffer.from(want.stderr, "utf8"));
    });
  }
});

describe("Node version", () => {
  for (const version of ["22.11.0", "23.9.0", "18.20.4"]) {
    test(`Node ${version} stops with exit code 3 before reading the arguments`, async () => {
      const got = await runMain(["help"], { nodeVersion: version });
      assert.equal(got.exitCode, 3);
      assert.equal(got.stdout.toString(), "");
      assert.equal(
        got.stderr.toString(),
        `js-prueffactory: needs Node 24 or newer, this is Node ${version}\n`,
      );
    });
  }

  for (const version of ["24.0.0", "26.5.0", "100.0.0"]) {
    test(`Node ${version} runs the command`, async () => {
      const got = await runMain(["help"], { nodeVersion: version });
      assert.equal(got.exitCode, 0);
      assert.equal(got.stderr.toString(), "");
    });
  }
});
