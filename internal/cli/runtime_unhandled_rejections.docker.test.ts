// Seam A tests of runtime.unhandled-rejections: a project goes in through the
// entry point, the Report comes out (Go:
// runtime_unhandled_rejections_docker_test.go). The testdata project
// unhandled-rejection has two packages with the same test, a floating promise
// that rejects while the test waits, and a listener that only logs: the root
// package runs Mocha 10, the package in mocha11 runs Mocha 11.
// unhandled-rejection-crash has a rejection that happens while its test file
// loads.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  executionsOf,
  type Finding,
  findingsOf,
  full,
  type Full,
  oneExecution,
} from "./suites.testutil.ts";

const rejections = "runtime.unhandled-rejections";

function rejectionFindingsOf(s: Full, rule: string): Finding[] {
  return findingsOf(s, rejections).filter((f) => f.rule_id === rule);
}

/** contextPath is the package folder of a Context of the Report. */
function contextPath(s: Full, id: string): string {
  const c = s.contexts.find((x) => x.id === id);
  assert.ok(c, `no Context ${id}`);
  return c.path;
}

test("a floating promise that passes normally fails in the strict run on Mocha 10 and 11", async (t) => {
  const original = copyProject(t, "unhandled-rejection");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", rejections]);

  // tests.existing is not selected: the strict failure is a warning and no Gate.
  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const execs = executionsOf(s, rejections);
  assert.equal(execs.length, 2, `one per package: ${JSON.stringify(execs)}`);
  for (const e of execs) {
    assert.equal(e.selected, true);
    assert.equal(e.status, "completed");
    assert.equal(e.gate, 0);
  }
  for (const e of executionsOf(s, "tests.existing")) {
    assert.equal(e.selected, false);
    assert.equal(
      e.status,
      "completed",
      "the first run is made without tests.existing being selected",
    );
  }

  const fs = rejectionFindingsOf(s, "unhandled-rejection");
  assert.equal(
    fs.length,
    2,
    `one for Mocha 10 and one for Mocha 11: ${JSON.stringify(findingsOf(s, rejections))}`,
  );
  const paths = new Set<string>();
  for (const f of fs) {
    paths.add(contextPath(s, f.context_id));
    assert.equal(f.severity, "warning");
    assert.equal(f.confidence, "likely");
    assert.equal(f.gate, false);
    assert.equal(
      f.title,
      "Test fails with strict unhandled rejections: user passes although its floating promise rejects",
    );
    for (const e of f.evidence) {
      assert.equal(e.trust, "untrusted_data", "project text must be untrusted");
    }
    const text = f.evidence.map((e) => e.text).join("\n");
    assert.ok(
      text.includes("user service is down"),
      `the error of the strict run: ${text}`,
    );
    const cmd = f.reproduction.test?.native_command.join(" ") ?? "";
    assert.ok(
      cmd.startsWith(
        "env NODE_OPTIONS=--unhandled-rejections=strict npx mocha ",
      ),
      cmd,
    );
  }
  assert.ok(
    paths.has(".") && paths.has("mocha11"),
    `Findings are in the packages ${[...paths].join(", ")}, want the root (Mocha 10) and mocha11`,
  );

  // tests.flaky is not selected, so the differences may be flakiness.
  const limits = s.limitations.filter(
    (l) =>
      l.reason_code === "flakiness_not_excluded" && l.check_id === rejections,
  );
  assert.equal(
    limits.length,
    2,
    `one per package: ${JSON.stringify(s.limitations)}`,
  );
  // The first run is the reference for the Inventory and is unchanged.
  for (const p of s.inventory.tests) {
    assert.deepEqual(
      [p.found, p.passed, p.failed],
      [2, 2, 0],
      "the two passing tests of the first run",
    );
  }
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("with tests.flaky the strict run is the fourth run and no Limitation remains", async (t) => {
  const original = copyProject(t, "unhandled-rejection");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `tests.flaky,${rejections}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(
    rejectionFindingsOf(s, "unhandled-rejection").length,
    2,
    "the test does not differ between the runs without the flag",
  );
  assert.deepEqual(findingsOf(s, "tests.flaky"), []);
  for (const l of s.limitations) {
    assert.notEqual(
      l.reason_code,
      "flakiness_not_excluded",
      "tests.flaky ran, so flakiness is excluded",
    );
  }
  for (const m of s.metrics) {
    if (m.check_id === rejections && m.name === "explained_by_flakiness") {
      assert.equal(m.value, 0);
    }
  }
  const logs = new Map<string, number>();
  for (const a of s.artifacts) {
    if (a.path.includes("test-output-run")) {
      const key = `${a.check_id}/${a.path.slice(a.path.lastIndexOf("/") + 1)}`;
      logs.set(key, (logs.get(key) ?? 0) + 1);
    }
  }
  for (const want of [
    "tests.flaky/test-output-run2.log",
    "tests.flaky/test-output-run3.log",
    `${rejections}/test-output-run4.log`,
  ]) {
    assert.equal(
      logs.get(want),
      2,
      `command logs ${JSON.stringify([...logs])}, want ${want} once per package`,
    );
  }
  assertNothingLeft(r);
});

test("an error while a test file loads is one Finding for the suite and not one per test", async (t) => {
  const original = copyProject(t, "unhandled-rejection-crash");

  const r = await realRun(t, ["test", original, "--only", rejections]);

  assert.equal(r.code, 0, `the normal run passes\n${r.stderr}`);
  const s = full(r);
  const all = findingsOf(s, rejections);
  assert.equal(
    all.length,
    1,
    `the one crash Finding and nothing for the tests that never ran: ${JSON.stringify(all)}`,
  );
  const f = all[0];
  assert.ok(f);
  assert.equal(f.rule_id, "unhandled-rejection-crash");
  assert.equal(f.severity, "warning");
  assert.equal(f.confidence, "likely");
  assert.equal(f.gate, false);
  const text = f.evidence.map((e) => e.text).join("\n");
  assert.ok(
    text.includes("the setup call failed while the file loads"),
    `the uncaught error: ${text}`,
  );
  const loc = f.locations[0];
  assert.equal(loc?.path, "test/load.test.js");
  assert.equal(loc.start?.line, 12, "the line of the rejected promise");
  assertNothingLeft(r);
});

test("a clean project has no unhandled rejection", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `tests.flaky,${rejections}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, rejections).status, "completed");
  assert.deepEqual(findingsOf(s, rejections), []);
  assertNothingLeft(r);
});

test("the Benchmark counts the strict run Findings in the code correctness area", async (t) => {
  const original = copyProject(t, "unhandled-rejection");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    `package.install,tests.existing,tests.flaky,${rejections}`,
  ]);

  const s = full(r);
  let part:
    | { state: string; raw_value: number | null; score: number | null }
    | undefined;
  for (const a of s.benchmark?.areas ?? []) {
    part ??= a.parts.find((x) => x.id === "unhandled_rejections");
  }
  assert.ok(part, "no Benchmark part unhandled_rejections");
  assert.equal(part.state, "measured");
  assert.equal(part.raw_value, 2);
  assert.equal(part.score, 50, "two Findings: 100 * 2^(-2/2) = 50");
  assertNothingLeft(r);
});
