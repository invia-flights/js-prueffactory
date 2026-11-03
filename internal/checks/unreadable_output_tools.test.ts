// A tool whose output cannot be read is a tool problem (spec "Trustworthy
// gates", ticket 05): the adapters of ticket 04 covered the description,
// pipeline and deployment Checks; this file feeds unreadable output (a changed
// JSON shape, truncated output, plain text) to the adapters of the other
// Checks. Each case ends tool_error (or partial when other calls could be
// read) with the reason code tool_output_unreadable, makes no Finding, and
// keeps the raw output as artifacts that the reason names. The tools run as
// stood-in containers that answer like Docker does.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertUnreadable,
  runInPackage,
} from "./unreadable_output.testutil.ts";
import { newShared } from "./shared.ts";

const pkg = {
  "package.json": '{"name":"x","version":"1.0.0"}',
  "index.js": "module.exports = 1;\n",
};

// --- the combined ESLint run (lint.correctness, deps.engines, quality.metrics, tests.smells) ---

const eslintGood = JSON.stringify({
  version: "10.0.0",
  exit_code: 0,
  command: ["node", "eslint"],
  config: {},
  groups: {},
  results: [],
  dropped_messages: 0,
  measures: [],
  measures_dropped: 0,
  measures_unreadable: 0,
});

const eslintBad: Record<string, string> = {
  "a changed JSON shape": '{"files":[{"path":"index.js"}]}',
  "truncated output": eslintGood.slice(0, 40),
  "plain text": "node: --input-type is not allowed here",
};

for (const [what, out] of Object.entries(eslintBad)) {
  for (const check of [
    "lint.correctness",
    "deps.engines",
    "quality.metrics",
    "tests.smells",
  ]) {
    test(`${check}: ${what} from the ESLint helper is a tool problem with the raw output kept`, async (t) => {
      const res = await runInPackage(
        t,
        check,
        { ...pkg, "test/a.test.js": "it('x', () => {});\n" },
        () => ({ stdout: out, stderr: "warning text" }),
        { shared: newShared() },
      );
      assertUnreadable(res, {
        status: "tool_error",
        check,
        context: "C-0002",
        call: "eslint",
        stdout: out,
        stderr: "warning text",
      });
      assert.deepEqual(res.findings ?? [], []);
    });
  }
}

test("lint.correctness: the helper's document that is read is still read", async (t) => {
  const res = await runInPackage(
    t,
    "lint.correctness",
    pkg,
    () => ({ stdout: eslintGood }),
    { shared: newShared() },
  );
  assert.equal(res.status, "completed", res.reason ?? "");
  assert.equal(res.reasonCode, undefined);
});

test("lint.correctness: a helper that exits with an error stays a helper failure", async (t) => {
  const res = await runInPackage(
    t,
    "lint.correctness",
    pkg,
    () => ({ exitCode: 1, stderr: "Error: eslint failed" }),
    { shared: newShared() },
  );
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "helper_failed"],
  );
});

// --- lint.typed (ESLint with typescript-eslint, in a run of its own) ---

const typedPkg = {
  "package.json": '{"name":"x","version":"1.0.0"}',
  "src/a.ts": "export const a: number = 1;\n",
};
const typedGood = JSON.stringify([
  {
    filePath: "/work/src/a.ts",
    messages: [
      { ruleId: null, severity: 1, message: "note", line: 1, column: 1 },
    ],
  },
]);
const typedBad: Record<string, string> = {
  "a changed JSON shape": '{"results":[{"path":"src/a.ts"}]}',
  "elements with other keys": '[{"file":"src/a.ts","problems":[]}]',
  "truncated output": typedGood.slice(0, 30),
  "plain text": "Oops! Something went wrong! :(\n\nESLint: 10.0.0",
};

for (const [what, out] of Object.entries(typedBad)) {
  test(`lint.typed: ${what} from ESLint is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "lint.typed", typedPkg, () => ({
      stdout: out,
      stderr: "eslint warnings",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "lint.typed",
      context: "C-0002",
      call: "typedlint",
      stdout: out,
      stderr: "eslint warnings",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("lint.typed: ESLint output that is read is still read", async (t) => {
  const res = await runInPackage(t, "lint.typed", typedPkg, () => ({
    stdout: typedGood,
  }));
  assert.equal(res.status, "completed", res.reason ?? "");
});

// --- Knip (quality.unused) ---

const knipGood =
  '{"files":[],"issues":[{"file":"index.js","dependencies":[],"exports":[{"name":"unused","line":1,"col":1,"pos":0}]}]}';
const knipBad: Record<string, string> = {
  "a changed JSON shape": '{"results":[{"path":"index.js"}]}',
  "issues of another type": '{"issues":{"index.js":["unused"]}}',
  "issues with other keys": '{"issues":[{"path":"index.js","unused":[]}]}',
  "truncated output": knipGood.slice(0, 50),
  "plain text": "Error: Cannot find module 'jiti'",
};

for (const [what, out] of Object.entries(knipBad)) {
  test(`quality.unused: ${what} from Knip is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "quality.unused", pkg, () => ({
      stdout: out,
      stderr: "knip stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "quality.unused",
      context: "C-0002",
      call: "knip",
      stdout: out,
      stderr: "knip stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("quality.unused: Knip output that is read is still read", async (t) => {
  const res = await runInPackage(t, "quality.unused", pkg, () => ({
    stdout: knipGood,
  }));
  assert.equal(res.status, "completed", res.reason ?? "");
  assert.equal(res.findings?.length, 1);
});

test("quality.unused: Knip exiting with an error stays a tool failure", async (t) => {
  const res = await runInPackage(t, "quality.unused", pkg, () => ({
    exitCode: 2,
    stderr: "boom",
  }));
  assert.deepEqual([res.status, res.reasonCode], ["tool_error", "knip_failed"]);
});

// (more adapters below)
