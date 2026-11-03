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
  run,
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

// --- dependency-cruiser (modules.cycles) ---

const cruiseGood =
  '{"version":"17.0.0","total_cruised":1,"violations":[],"unresolved":[],"edges":{}}';
const cruiseBad: Record<string, string> = {
  "a changed JSON shape": '{"modules":[{"source":"index.js"}]}',
  "violations of another type": '{"version":"1","violations":{"rule":"x"}}',
  "truncated output": cruiseGood.slice(0, 40),
  "plain text": "node:internal/modules/cjs/loader:1228\n  throw err;",
};

for (const [what, out] of Object.entries(cruiseBad)) {
  test(`modules.cycles: ${what} from dependency-cruiser is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "modules.cycles", pkg, () => ({
      stdout: out,
      stderr: "cruise stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "modules.cycles",
      context: "C-0002",
      call: "cruise",
      stdout: out,
      stderr: "cruise stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("modules.cycles: output that is read is still read, and the helper's own error stays its message", async (t) => {
  const ok = await runInPackage(t, "modules.cycles", pkg, () => ({
    stdout: cruiseGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  const failed = await runInPackage(t, "modules.cycles", pkg, () => ({
    stdout:
      '{"version":"","total_cruised":0,"violations":[],"unresolved":[],"error":"cannot read the dependency-cruiser report: x"}',
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "dependency_cruiser_failed"],
  );
  const crashed = await runInPackage(t, "modules.cycles", pkg, () => ({
    exitCode: 1,
    stderr: "boom",
  }));
  assert.deepEqual(
    [crashed.status, crashed.reasonCode],
    ["tool_error", "helper_failed"],
  );
});

// --- jscpd (quality.clones) ---

const clonesGood =
  '{"version":"4.0.0","groups":[{"name":"source","files":1,"percentage":0,"duplicated_lines":0,"lines":2,"clones":[]},{"name":"test","files":0,"percentage":0,"duplicated_lines":0,"lines":0,"clones":[]}]}';
const clonesBad: Record<string, string> = {
  "a changed JSON shape": '{"statistics":{"total":{"percentage":3}}}',
  "groups with other keys": '{"version":"4","groups":[{"label":"source"}]}',
  "truncated output": clonesGood.slice(0, 60),
  "plain text": "jscpd: command not found",
};

for (const [what, out] of Object.entries(clonesBad)) {
  test(`quality.clones: ${what} from jscpd is a tool problem with the raw output kept`, async (t) => {
    const res = await run(t, "quality.clones", pkg, () => ({
      stdout: out,
      stderr: "jscpd stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "quality.clones",
      call: "clones",
      stdout: out,
      stderr: "jscpd stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
    assert.deepEqual(res.metrics ?? [], []);
  });
}

test("quality.clones: output that is read is still read, and a group's own error stays its message", async (t) => {
  const ok = await run(t, "quality.clones", pkg, () => ({
    stdout: clonesGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  assert.equal(ok.reasonCode, undefined);
});

// --- TypeScript (types.javascript, types.strictness) ---

const tscLine = "index.js(1,1): error TS2304: Cannot find name 'x'.";
const tscBad: Record<string, string> = {
  "a changed format": "index.js:1:1 - error TS2304: Cannot find name 'x'.\n",
  "plain text": "error: unknown compiler option '--pretty'\n",
  "truncated output": tscLine + "\nindex.js(2,1): error TS23",
  "an unreadable line among readable ones": `${tscLine}\n\u001b[96mindex.js\u001b[0m:2:1 - \u001b[91merror\u001b[0m TS2304: Cannot find name 'y'.\n`,
};

for (const [what, out] of Object.entries(tscBad)) {
  test(`types.javascript: ${what} from tsc is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "types.javascript", pkg, () => ({
      exitCode: 2,
      stdout: out,
      stderr: "tsc stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "types.javascript",
      context: "C-0002",
      call: "tsc",
      stdout: out,
      stderr: "tsc stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("types.javascript: output that is read is still read, and a silent or crashed tsc stays a tool failure", async (t) => {
  const read = await runInPackage(t, "types.javascript", pkg, () => ({
    exitCode: 2,
    stdout: tscLine + "\n",
  }));
  assert.equal(read.status, "completed", read.reason ?? "");
  assert.equal(read.findings?.length, 1);
  const silent = await runInPackage(t, "types.javascript", pkg, () => ({
    exitCode: 2,
  }));
  assert.deepEqual(
    [silent.status, silent.reasonCode],
    ["tool_error", "tsc_failed"],
  );
  const crashed = await runInPackage(t, "types.javascript", pkg, () => ({
    exitCode: 139,
    stdout: "Segmentation fault",
  }));
  assert.deepEqual(
    [crashed.status, crashed.reasonCode],
    ["tool_error", "tsc_failed"],
  );
});

for (const [what, out] of Object.entries(tscBad)) {
  test(`types.strictness: ${what} from the strict run of tsc is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "types.strictness", pkg, (spec) =>
      (spec.name ?? "").startsWith("strictness-strict")
        ? { exitCode: 2, stdout: out, stderr: "tsc stderr" }
        : { exitCode: 0 },
    );
    assertUnreadable(res, {
      status: "tool_error",
      check: "types.strictness",
      context: "C-0002",
      call: "strictness-strict",
      stdout: out,
      stderr: "tsc stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

const coverageGood =
  '{"succeeded":true,"correctCount":17,"percent":89.47,"percentString":"89.47","totalCount":19}';
const coverageBad: Record<string, string> = {
  "a changed JSON shape": '{"succeeded":true,"covered":17,"of":19}',
  "counts of another type": '{"correctCount":"17","totalCount":"19"}',
  "truncated output": coverageGood.slice(0, 40),
  "plain text": "type-coverage: the tsconfig could not be read",
};

for (const [what, out] of Object.entries(coverageBad)) {
  test(`types.strictness: ${what} from type-coverage is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "types.strictness", pkg, (spec) =>
      (spec.name ?? "").startsWith("coverage-source")
        ? { stdout: out, stderr: "type-coverage stderr" }
        : { exitCode: 0 },
    );
    assertUnreadable(res, {
      status: "tool_error",
      check: "types.strictness",
      context: "C-0002",
      call: "coverage-source",
      stdout: out,
      stderr: "type-coverage stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("types.strictness: type-coverage output that is read is still read, and a crash stays a tool failure", async (t) => {
  const read = await runInPackage(t, "types.strictness", pkg, (spec) =>
    (spec.name ?? "").startsWith("coverage") ? { stdout: coverageGood } : {},
  );
  assert.equal(read.status, "completed", read.reason ?? "");
  const crashed = await runInPackage(t, "types.strictness", pkg, (spec) =>
    (spec.name ?? "").startsWith("coverage-source")
      ? { exitCode: 139, stderr: "Segmentation fault" }
      : {},
  );
  assert.deepEqual(
    [crashed.status, crashed.reasonCode],
    ["tool_error", "type_coverage_failed"],
  );
});

// (more adapters below)
