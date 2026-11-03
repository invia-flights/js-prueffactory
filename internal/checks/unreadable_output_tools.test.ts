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

import { validate } from "../resultset/validate.ts";
import { newSet } from "../resultset/zero.ts";
import {
  assertUnreadable,
  rawOf,
  run,
  runInPackage,
} from "./unreadable_output.testutil.ts";
import { newShared } from "./shared.ts";
import { suiteInput } from "./test_report.testutil.ts";
import { coverageResult } from "./tests_coverage.ts";
import { finalTwoFiles, summaryTwoFiles } from "./tests_coverage.testutil.ts";

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

// --- c8 (tests.coverage) ---

const c8Bad: Record<string, string> = {
  "a changed JSON shape":
    '{"total":{"lines":{"pct":61.5},"functions":{"pct":33}}}',
  "a summary without a total":
    '{"/work/pkg/src/index.js":{"lines":{"total":1,"covered":1}}}',
  "counts of another type":
    '{"total":{"lines":{"total":"13","covered":"8"},"functions":{"total":1,"covered":1},"branches":{"total":1,"covered":1}}}',
  "truncated output": summaryTwoFiles.slice(0, 120),
  "plain text": "c8: cannot find the coverage directory",
};

for (const [what, out] of Object.entries(c8Bad)) {
  test(`tests.coverage: ${what} from c8 is a tool problem with the raw files kept`, (t) => {
    const input = suiteInput(t, { "src/index.js": "x" });
    const res = coverageResult(input, {
      status: "completed",
      coverage: {
        unavailable: "",
        unavailableCode: "",
        summary: Buffer.from(out),
        perFile: Buffer.from(finalTwoFiles),
      },
    });
    assertUnreadable(res, {
      status: "tool_error",
      check: "tests.coverage",
      context: input.context.id,
      call: "c8",
      files: {
        "coverage-summary.json": out,
        "coverage-final.json": finalTwoFiles,
      },
    });
    assert.deepEqual(res.findings ?? [], []);
    for (const m of res.metrics ?? []) {
      assert.equal(m.value, null, `${m.name} is not measured`);
    }
  });
}

test("tests.coverage: a good total with entries of files that have no counts says so in the reason", (t) => {
  const out =
    '{"total":{"lines":{"total":1,"covered":1},"functions":{"total":1,"covered":1},"branches":{"total":1,"covered":1}},"/work/pkg/src/index.js":"covered"}';
  const input = suiteInput(t, { "src/index.js": "x" });
  const res = coverageResult(input, {
    status: "completed",
    coverage: {
      unavailable: "",
      unavailableCode: "",
      summary: Buffer.from(out),
      perFile: null,
    },
  });
  assertUnreadable(res, {
    status: "tool_error",
    check: "tests.coverage",
    context: input.context.id,
    call: "c8",
    files: { "coverage-summary.json": out },
  });
  assert.ok(
    (res.reason ?? "").includes("the entries of its files"),
    res.reason ?? "",
  );
  for (const m of res.metrics ?? []) {
    assert.ok(
      (m.reason ?? "").includes("the entries of its files"),
      m.reason ?? "",
    );
  }
});

test("tests.coverage: a summary that is read is still read", (t) => {
  const res = coverageResult(suiteInput(t, { "src/index.js": "x" }), {
    status: "completed",
    coverage: {
      unavailable: "",
      unavailableCode: "",
      summary: Buffer.from(summaryTwoFiles),
      perFile: null,
    },
  });
  assert.equal(res.status, "completed", res.reason ?? "");
  assert.equal(res.metrics?.length, 3);
});

// --- gitleaks (security.secrets) ---

const leak =
  '{"RuleID":"generic-api-key","Description":"a key","StartLine":1,"EndLine":1,"StartColumn":1,"EndColumn":12,"File":"/snapshot/a.js"}';
const gitleaksBad: Record<string, string> = {
  "a changed JSON shape": '{"findings":[' + leak + "]}",
  "elements with other keys": '[{"rule":"generic-api-key","path":"a.js"}]',
  "truncated output": "[" + leak.slice(0, 60),
  "plain text": "6:12AM FTL failed to load config",
};

const secretsRun = (
  t: Parameters<typeof run>[0],
  answer: Parameters<typeof run>[3],
) =>
  run(t, "security.secrets", { "a.js": "var a = 1;\n" }, answer, {
    snapshotTar: () => Promise.resolve(),
  });

// Made up. A report of a changed shape, or one that ignored --redact, may hold
// the value gitleaks flagged, and redaction cannot know it: the scan that
// finds the values is the one that failed. So its raw output is not kept.
const madeUpSecret = "sk_prod_4f9aQ7xT2mWz8LkB5nRc1VdJ";

/** assertNoRawOutput checks that nothing of the tool's output is in the Report. */
function assertNoRawOutput(res: Awaited<ReturnType<typeof secretsRun>>): void {
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "tool_output_unreadable"],
    res.reason ?? "",
  );
  assert.deepEqual(res.artifacts ?? [], [], "no raw output is kept");
  assert.deepEqual(res.findings ?? [], []);
  assert.deepEqual(res.redact ?? [], []);
  assert.ok(
    (res.reason ?? "").includes(
      "The raw output of gitleaks is not kept, because it may hold the secrets this scan looks for.",
    ),
    res.reason ?? "",
  );
  assert.ok(!JSON.stringify(res).includes(madeUpSecret), "the value leaks");
}

for (const [what, out] of Object.entries(gitleaksBad)) {
  test(`security.secrets: ${what} from gitleaks is a tool problem and its raw output is not kept`, async (t) => {
    const res = await secretsRun(t, () => ({
      exitCode: 2,
      stdout: out.replace("a.js", `a.js","Secret":"${madeUpSecret}`),
      stderr: `gitleaks stderr ${madeUpSecret}`,
    }));
    assertNoRawOutput(res);
  });
}

test("security.secrets: an exit code that says leaks were found with an empty report is a tool problem", async (t) => {
  const res = await secretsRun(t, () => ({ exitCode: 2 }));
  assertNoRawOutput(res);
});

test("security.secrets: a report that is read is still read, and another exit code stays a tool failure", async (t) => {
  const clean = await secretsRun(t, () => ({ stdout: "[]" }));
  assert.equal(clean.status, "completed", clean.reason ?? "");
  assert.equal(clean.findings?.length ?? 0, 0);
  const none = await secretsRun(t, () => ({}));
  assert.equal(none.status, "completed", "no output at all is no leak");
  const found = await secretsRun(t, () => ({
    exitCode: 2,
    stdout: "[" + leak + "]",
  }));
  assert.equal(found.status, "completed", found.reason ?? "");
  assert.equal(found.findings?.length, 1);
  const failed = await secretsRun(t, () => ({
    exitCode: 1,
    stderr: "boom",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "tool_failed"],
  );
});

// --- osv-scanner (security.dependencies) ---

const lock = JSON.stringify({
  name: "x",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "x", version: "1.0.0", dependencies: { minimist: "1.2.5" } },
    "node_modules/minimist": {
      version: "1.2.5",
      resolved: "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz",
      integrity: "sha512-AAAA",
    },
  },
});
const osvPkg = {
  "package.json": '{"name":"x","version":"1.0.0"}',
  "package-lock.json": lock,
};
const osvGood =
  '{"results":[{"source":{"path":"/scan/package-lock.json","type":"lockfile"},"packages":[{"package":{"name":"minimist","version":"1.2.5","ecosystem":"npm"}}]}]}';
const osvBad: Record<string, string> = {
  "a changed JSON shape": '{"findings":[{"id":"GHSA-1"}]}',
  "results of another type": '{"results":{"packages":[]}}',
  "truncated output": osvGood.slice(0, 80),
  "plain text": "Scanned /scan/package-lock.json file and found 1 package",
};
const osvAdvisories = {
  advisoryVolume: "jspf-advisory",
  advisoryDate: new Date("2026-11-03T00:00:00Z"),
};

for (const [what, out] of Object.entries(osvBad)) {
  test(`security.dependencies: ${what} from osv-scanner is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(
      t,
      "security.dependencies",
      osvPkg,
      () => ({ stdout: out, stderr: "osv stderr" }),
      osvAdvisories,
    );
    assertUnreadable(res, {
      status: "tool_error",
      check: "security.dependencies",
      context: "C-0002",
      call: "osv",
      stdout: out,
      stderr: "osv stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("security.dependencies: exit 1 for vulnerabilities with a report that names none is a tool problem", async (t) => {
  const res = await runInPackage(
    t,
    "security.dependencies",
    osvPkg,
    () => ({ exitCode: 1, stdout: osvGood }),
    osvAdvisories,
  );
  assertUnreadable(res, {
    status: "tool_error",
    check: "security.dependencies",
    context: "C-0002",
    call: "osv",
    stdout: osvGood,
  });
  assert.ok(
    (res.reason ?? "").includes(
      "it exited with its code for found vulnerabilities but its report names none",
    ),
    res.reason ?? "",
  );
});

test("security.dependencies: a report of another type says it is not the JSON report osv-scanner documents", async (t) => {
  const res = await runInPackage(
    t,
    "security.dependencies",
    osvPkg,
    () => ({ stdout: '{"results":"none"}' }),
    osvAdvisories,
  );
  assert.equal(res.reasonCode, "tool_output_unreadable", res.reason ?? "");
  assert.ok(
    !(res.reason ?? "").includes("found vulnerabilities"),
    res.reason ?? "",
  );
});

test("security.dependencies: a report that is read is still read, and a crash stays a tool failure", async (t) => {
  const ok = await runInPackage(
    t,
    "security.dependencies",
    osvPkg,
    () => ({ stdout: osvGood }),
    osvAdvisories,
  );
  assert.equal(ok.status, "completed", ok.reason ?? "");
  const failed = await runInPackage(
    t,
    "security.dependencies",
    osvPkg,
    () => ({ exitCode: 127, stderr: "boom" }),
    osvAdvisories,
  );
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "tool_failed"],
  );
});

// --- njsscan and semgrep (security.patterns) ---

const njsscanGood =
  '{"errors":[],"njsscan_version":"0.4.3","nodejs":{},"templates":{},"version":"1.0"}';
const semgrepGood =
  '{"version":"1.0","results":[],"errors":[],"paths":{"scanned":[]}}';
const njsscanBad: Record<string, string> = {
  "a changed JSON shape": '{"findings":[{"rule":"x"}]}',
  "rules of another type": '{"nodejs":["node_xss"],"templates":{}}',
  "rules with other keys":
    '{"nodejs":{"node_xss":{"description":"x"}},"templates":{}}',
  "truncated output": njsscanGood.slice(0, 50),
  "plain text": "njsscan: error: unrecognized arguments: --json",
};
const semgrepBad: Record<string, string> = {
  "a changed JSON shape": '{"findings":[{"rule":"x"}]}',
  "results of another type": '{"results":{"path":"a.js"}}',
  "results with other keys": '{"results":[{"file":"a.js","rule":"x"}]}',
  "truncated output": semgrepGood.slice(0, 40),
  "plain text": "semgrep: error: unrecognized arguments",
};

for (const [what, out] of Object.entries(njsscanBad)) {
  test(`security.patterns: ${what} from njsscan is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "security.patterns", pkg, () => ({
      exitCode: 1,
      stdout: out,
      stderr: "njsscan stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "security.patterns",
      context: "C-0002",
      call: "njsscan-c-0002",
      stdout: out,
      stderr: "njsscan stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

for (const [what, out] of Object.entries(semgrepBad)) {
  test(`security.patterns: ${what} from semgrep is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "security.patterns", pkg, (spec) =>
      (spec.name ?? "").startsWith("semgrep")
        ? { stdout: out, stderr: "semgrep stderr" }
        : { stdout: njsscanGood },
    );
    assertUnreadable(res, {
      status: "tool_error",
      check: "security.patterns",
      context: "C-0002",
      call: "semgrep-c-0002",
      stdout: out,
      stderr: "semgrep stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("security.patterns: reports that are read are still read, and a crash stays a tool failure", async (t) => {
  const ok = await runInPackage(t, "security.patterns", pkg, (spec) => ({
    stdout: (spec.name ?? "").startsWith("semgrep") ? semgrepGood : njsscanGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  const failed = await runInPackage(t, "security.patterns", pkg, () => ({
    exitCode: 2,
    stderr: "boom",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "tool_failed"],
  );
});

// --- npm ls (deps.tree) ---

const npmLsGood =
  '{"version":"1.0.0","name":"x","problems":["missing: left-pad@1.3.0, required by x@1.0.0"]}';
const npmLsBad: Record<string, [number, string]> = {
  "a changed JSON shape": [0, '{"problems":"missing: left-pad@1.3.0"}'],
  "a list instead of the document": [0, '[{"name":"x"}]'],
  "an error document without a problem": [
    1,
    '{"error":{"code":"ELSPROBLEMS","summary":"x"}}',
  ],
  "truncated output": [1, npmLsGood.slice(0, 60)],
  "plain text": [1, "npm error code ELSPROBLEMS"],
};

for (const [what, [exitCode, out]] of Object.entries(npmLsBad)) {
  test(`deps.tree: ${what} from npm ls is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "deps.tree", pkg, () => ({
      exitCode,
      stdout: out,
      stderr: "npm stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "deps.tree",
      context: "C-0002",
      call: "npm-ls",
      stdout: out,
      stderr: "npm stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("deps.tree: output that is read is still read, and another exit code stays a tool failure", async (t) => {
  const found = await runInPackage(t, "deps.tree", pkg, () => ({
    exitCode: 1,
    stdout: npmLsGood,
  }));
  assert.equal(found.status, "completed", found.reason ?? "");
  assert.equal(found.findings?.length, 1);
  const clean = await runInPackage(t, "deps.tree", pkg, () => ({
    stdout: "{}",
  }));
  assert.equal(clean.status, "completed", clean.reason ?? "");
  const failed = await runInPackage(t, "deps.tree", pkg, () => ({
    exitCode: 127,
    stderr: "npm: command not found",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "npm_ls_failed"],
  );
});

// --- npm sbom (sbom.generate) ---

const sbomGood =
  '{"bomFormat":"CycloneDX","specVersion":"1.5","components":[{"name":"minimist"}]}';
const sbomBad: Record<string, string> = {
  "another document format": '{"spdxVersion":"SPDX-2.3","packages":[]}',
  "components of another type":
    '{"bomFormat":"CycloneDX","components":{"minimist":{}}}',
  "truncated output": sbomGood.slice(0, 50),
  "plain text": "npm warn config production Use `--omit=dev` instead.",
};

for (const [what, out] of Object.entries(sbomBad)) {
  test(`sbom.generate: ${what} from npm sbom is a tool problem with the raw output kept`, async (t) => {
    const res = await runInPackage(t, "sbom.generate", osvPkg, () => ({
      stdout: out,
      stderr: "npm stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "sbom.generate",
      context: "C-0002",
      call: "sbom",
      stdout: out,
      stderr: "npm stderr",
    });
    assert.deepEqual(res.metrics ?? [], []);
  });
}

test("sbom.generate: a document that is read is still read, and a failing npm stays a tool failure", async (t) => {
  const ok = await runInPackage(t, "sbom.generate", osvPkg, () => ({
    stdout: sbomGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  assert.equal(ok.metrics?.[0]?.value, 1);
  const failed = await runInPackage(t, "sbom.generate", osvPkg, () => ({
    exitCode: 1,
    stderr: "npm error",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "npm_sbom_failed"],
  );
});

// --- the registry data fetch (deps.outdated, deps.deprecated) ---

const registryPkg = {
  "package.json":
    '{"name":"x","version":"1.0.0","dependencies":{"minimist":"1.2.5"}}',
  "package-lock.json": lock,
};
const registryGood =
  '{"fetched_at":"2026-11-03T00:00:00.000Z","packages":[{"name":"minimist","registry":"registry.npmjs.org","status":"ok","latest":"1.2.5","latest_deprecated":"","versions":{"1.2.5":{"deprecated":"","published":"2020-03-12T00:00:00.000Z"}}}]}';
const registryBad: Record<string, string> = {
  "a changed JSON shape": '{"results":[{"name":"minimist","status":"ok"}]}',
  "packages of another type":
    '{"fetched_at":"2026-11-03T00:00:00.000Z","packages":{"minimist":"ok"}}',
  "answers with other keys":
    '{"fetched_at":"2026-11-03T00:00:00.000Z","packages":[{"pkg":"minimist","state":"ok"}]}',
  "truncated output": registryGood.slice(0, 90),
  "plain text": "node:internal/modules/cjs/loader:1228\n  throw err;",
};

for (const check of ["deps.outdated", "deps.deprecated"]) {
  for (const [what, out] of Object.entries(registryBad)) {
    test(`${check}: ${what} from the registry helper is a tool problem with the raw output kept`, async (t) => {
      const res = await runInPackage(t, check, registryPkg, () => ({
        stdout: out,
        stderr: "helper stderr",
      }));
      assertUnreadable(res, {
        status: "tool_error",
        check,
        context: "C-0002",
        call: "registry",
        stdout: out,
        stderr: "helper stderr",
      });
      assert.deepEqual(res.findings ?? [], []);
      assert.deepEqual(res.metrics ?? [], []);
    });
  }
}

test("deps.outdated: an answer that is read is still read, and a helper that exits with an error stays a helper failure", async (t) => {
  const ok = await runInPackage(t, "deps.outdated", registryPkg, () => ({
    stdout: registryGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  const failed = await runInPackage(t, "deps.outdated", registryPkg, () => ({
    exitCode: 1,
    stderr: "boom",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "helper_failed"],
  );
});

// --- node --check (syntax.parse; its failures are Gates) ---

const syntaxGood =
  '{"node_version":"v24.0.0","checked":1,"failures":[],"errors":[]}';
const syntaxBad: Record<string, string> = {
  "a changed JSON shape": '{"results":[{"file":"index.js","ok":false}]}',
  "failures with other keys":
    '{"node_version":"v24.0.0","checked":1,"failures":[{"file":"index.js","error":"x"}],"errors":[]}',
  "failures of another type":
    '{"node_version":"v24.0.0","checked":1,"failures":"index.js","errors":[]}',
  "truncated output": syntaxGood.slice(0, 40),
  "plain text": "node: bad option: --check",
};

for (const [what, out] of Object.entries(syntaxBad)) {
  test(`syntax.parse: ${what} from the helper is a tool problem with the raw output kept, never a Gate`, async (t) => {
    const res = await runInPackage(t, "syntax.parse", pkg, () => ({
      stdout: out,
      stderr: "helper stderr",
    }));
    assertUnreadable(res, {
      status: "tool_error",
      check: "syntax.parse",
      context: "C-0002",
      call: "syntax",
      stdout: out,
      stderr: "helper stderr",
    });
    assert.deepEqual(res.findings ?? [], []);
  });
}

test("syntax.parse: a document that is read is still read, and a helper that exits with an error stays a helper failure", async (t) => {
  const ok = await runInPackage(t, "syntax.parse", pkg, () => ({
    stdout: syntaxGood,
  }));
  assert.equal(ok.status, "completed", ok.reason ?? "");
  const failed = await runInPackage(t, "syntax.parse", pkg, () => ({
    exitCode: 1,
    stderr: "boom",
  }));
  assert.deepEqual(
    [failed.status, failed.reasonCode],
    ["tool_error", "helper_failed"],
  );
  const broken = await runInPackage(t, "syntax.parse", pkg, () => ({
    stdout:
      '{"node_version":"v24.0.0","checked":1,"failures":[{"path":"index.js","line":1,"column":1,"rule":"syntax-error","message":"Unexpected token","output":"SyntaxError"}],"errors":[]}',
  }));
  assert.equal(broken.findings?.length, 1);
  assert.equal(broken.findings[0]?.gate, true, "a real failure is a Gate");
});

// --- the test reporters' event files (tests.existing) ---

const mochaPkg = {
  "package.json": '{"name":"x","version":"1.0.0","scripts":{"test":"mocha"}}',
  "test/a.test.js": "it('adds', () => {});\n",
};
const evFound =
  '{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"adds","fullTitle":"adds","suitePath":[]}';
const evFound2 =
  '{"ev":"found","id":2,"file":"/work/test/a.test.js","title":"subtracts","fullTitle":"subtracts","suitePath":[]}';
const evPassed = '{"ev":"result","id":1,"outcome":"passed","duration":3}';

/** mochaRun runs tests.existing with a stood-in Mocha that wrote the event file. */
function mochaRun(
  t: Parameters<typeof run>[0],
  events: string | null,
  runner: { exitCode?: number; stdout?: string; stderr?: string } = {},
) {
  return runInPackage(t, "tests.existing", mochaPkg, (spec) => {
    const name = spec.name ?? "";
    if (name.startsWith("mochaprobe")) {
      return { stdout: '{"version":"11.0.0","bin":"bin/mocha.js"}' };
    }
    if (name.startsWith("tests-")) {
      return runner;
    }
    if (name.startsWith("events-")) {
      return events === null ? { exitCode: 1 } : { stdout: events };
    }
    return {};
  });
}

test("tests.existing: a truncated last line of the event file keeps the results read so far", async (t) => {
  const res = await mochaRun(
    t,
    [evFound, evFound2, evPassed, '{"ev":"result","id":2,"outc'].join("\n"),
  );
  assert.notEqual(res.reasonCode, "tool_output_unreadable");
  // Today's behaviour: what was read stays, the test that never reported is
  // never_run, and the run that did not end is the Finding it always was.
  assert.deepEqual(
    (res.testCases ?? []).map((c) => c.testCase.outcome),
    ["passed", "never_run"],
  );
  assert.ok(
    (res.findings ?? []).some((f) => f.rule_id === "test-run-aborted"),
    (res.findings ?? []).map((f) => f.rule_id).join(","),
  );
});

const eventsWithoutLines: Record<string, string | null> = {
  "an empty file": "",
  "no file": null,
  "a file of plain text": "node: bad option: --test-reporter-destination\n",
  "a file whose only line is cut off": '{"ev":"found","id":1,"fi',
};

for (const [what, events] of Object.entries(eventsWithoutLines)) {
  test(`tests.existing: ${what} where the runner exited cleanly is a tool problem with the raw output kept`, async (t) => {
    const res = await mochaRun(t, events, {
      stdout: "Usage: mocha [spec..]",
      stderr: "runner stderr",
    });
    assert.deepEqual(
      [res.status, res.reasonCode],
      ["tool_error", "tool_output_unreadable"],
      res.reason ?? "",
    );
    assert.deepEqual(
      (res.findings ?? []).filter((f) => f.gate),
      [],
    );
    assert.deepEqual(res.findings ?? [], []);
    assert.deepEqual(res.testCases ?? [], []);
    // The runner's streams are in the command log; the event file is stored
    // beside it when it has content. The reason names both.
    const base = "artifacts/tests.existing/C-0002/test-output";
    const log = rawOf(res, `${base}.log`) ?? "";
    assert.ok(log.includes("Usage: mocha [spec..]"), log);
    assert.ok(log.includes("runner stderr"), log);
    const kept = rawOf(res, `${base}.events.jsonl`);
    assert.equal(kept, events === "" || events === null ? undefined : events);
    assert.equal(
      (res.artifacts ?? []).length,
      kept === undefined ? 1 : 2,
      "no second copy of the streams",
    );
    for (const a of res.artifacts ?? []) {
      assert.ok((res.reason ?? "").includes(a.path), a.path);
    }
  });
}

const twoSuitePkg = {
  "package.json": JSON.stringify({
    name: "x",
    version: "1.0.0",
    scripts: {
      test: "npm run test:unit && npm run test:api",
      "test:unit": "mocha test/unit",
      "test:api": "mocha test/api",
    },
  }),
  "test/unit/a.test.js": "it('adds', () => {});\n",
  "test/api/b.test.js": "it('lists', () => {});\n",
};

test("tests.existing: every suite of a package whose reporter wrote nothing keeps artifacts of its own, so the Report stays valid", async (t) => {
  const res = await runInPackage(t, "tests.existing", twoSuitePkg, (spec) => {
    const name = spec.name ?? "";
    if (name.startsWith("mochaprobe")) {
      return { stdout: '{"version":"11.0.0","bin":"bin/mocha.js"}' };
    }
    if (name.startsWith("tests-")) {
      return { stdout: `output of ${name}`, stderr: `stderr of ${name}` };
    }
    return {};
  });
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "tool_output_unreadable"],
    res.reason ?? "",
  );
  const set = newSet();
  set.artifacts = (res.artifacts ?? []).map((a, i) => ({
    ...a,
    id: `A-${String(i + 1).padStart(4, "0")}`,
  }));
  assert.deepEqual(
    validate(set).filter((p) => p.includes("share the path")),
    [],
    (res.artifacts ?? []).map((a) => a.path).join("\n"),
  );
  const logs = (res.artifacts ?? []).filter((a) => a.path.endsWith(".log"));
  assert.equal(logs.length, 2, "one command log per suite");
});

test("tests.existing: the command log already holds the runner's streams, so the unreadable reporter adds only the event file and names the log", async (t) => {
  const res = await runInPackage(t, "tests.existing", mochaPkg, (spec) => {
    const name = spec.name ?? "";
    if (name.startsWith("mochaprobe")) {
      return { stdout: '{"version":"11.0.0","bin":"bin/mocha.js"}' };
    }
    if (name.startsWith("tests-")) {
      return { stdout: "Usage: mocha [spec..]", stderr: "runner stderr" };
    }
    return name.startsWith("events-") ? { stdout: "not an event\n" } : {};
  });
  const paths = (res.artifacts ?? []).map((a) => a.path);
  assert.deepEqual(paths, [
    "artifacts/tests.existing/C-0002/test-output.log",
    "artifacts/tests.existing/C-0002/test-output.events.jsonl",
  ]);
  const log = rawOf(res, paths[0] ?? "") ?? "";
  assert.ok(log.includes("Usage: mocha [spec..]"), log);
  assert.ok(log.includes("runner stderr"), log);
  for (const p of paths) {
    assert.ok((res.reason ?? "").includes(p), `the reason names ${p}`);
  }
});

test("tests.existing: the node:test reporter's event file is read the same way", async (t) => {
  const res = await runInPackage(
    t,
    "tests.existing",
    {
      "package.json":
        '{"name":"x","version":"1.0.0","scripts":{"test":"node --test"}}',
      "test/a.test.js": "require('node:test')('adds', () => {});\n",
    },
    (spec) => {
      const name = spec.name ?? "";
      if (name.startsWith("tests-")) {
        return { stdout: "TAP version 13" };
      }
      return name.startsWith("events-") ? { stdout: "TAP version 13\n" } : {};
    },
  );
  assert.deepEqual(
    [res.status, res.reasonCode],
    ["tool_error", "tool_output_unreadable"],
    res.reason ?? "",
  );
  assert.deepEqual(res.findings ?? [], []);
  const base = "artifacts/tests.existing/C-0002/test-output";
  assert.deepEqual(
    (res.artifacts ?? []).map((a) => a.path),
    [`${base}.log`, `${base}.events.jsonl`],
  );
  assert.ok((rawOf(res, `${base}.log`) ?? "").includes("TAP version 13"));
  assert.equal(rawOf(res, `${base}.events.jsonl`), "TAP version 13\n");
});

test("tests.existing: a runner that exits with an error before any event is still the project's failure", async (t) => {
  const res = await mochaRun(t, "", {
    exitCode: 1,
    stderr: "Error: Cannot find module './missing'",
  });
  assert.notEqual(res.reasonCode, "tool_output_unreadable");
  assert.ok(
    (res.findings ?? []).some((f) => f.rule_id === "test-file-load-failed"),
    "the Finding of a test file that does not load",
  );
});

// (more adapters below)
