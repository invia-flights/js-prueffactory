// Seam A tests of tests.flaky: a project goes in through the entry point, the
// Report comes out (Go: tests_flaky_docker_test.go). The testdata project
// flaky-test has a test that fails only in the second run of the suite,
// because it counts the runs in a file of its package folder, a test that
// fails in every run and a test that always passes.
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

function flakyFindingsOf(s: Full): Finding[] {
  return findingsOf(s, "tests.flaky").filter((f) => f.rule_id === "flaky-test");
}

test("a test that fails only in the second run is reported with all three outcomes", async (t) => {
  const original = copyProject(t, "flaky-test");
  const before = treeFingerprint(original);

  const r = await realRun(t, ["test", original, "--only", "tests.flaky"]);

  // tests.existing is not selected, so the failing test is no Gate here.
  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "tests.flaky");
  assert.equal(e.selected, true);
  assert.equal(e.status, "completed");
  assert.equal(e.gate, 0);
  const tests = oneExecution(s, "tests.existing");
  assert.equal(tests.selected, false);
  assert.equal(
    tests.status,
    "completed",
    "the first run is made without tests.existing being selected",
  );

  const fs = flakyFindingsOf(s);
  assert.equal(
    fs.length,
    1,
    `Flaky test Findings: ${JSON.stringify(findingsOf(s, "tests.flaky"))}`,
  );
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.gate, false);
  assert.equal(
    f.title,
    "Flaky test: counter fails only in the second run (runs: passed, failed, passed)",
  );
  assert.equal(f.evidence.length, 3, "one item per run");
  for (const [i, want] of [
    "run 1 (first run): passed",
    "run 2: failed",
    "run 3: passed",
  ].entries()) {
    assert.ok(
      f.evidence[i]?.text.startsWith(want),
      `evidence ${String(i)} = ${f.evidence[i]?.text ?? ""}, want it to start with ${want}`,
    );
  }
  assert.ok(
    f.evidence[1]?.text.includes("this is run 2"),
    `the failed run lists its error: ${f.evidence[1]?.text ?? ""}`,
  );
  const tr = f.reproduction.test;
  assert.ok(tr);
  assert.equal(tr.file, "test/counter.test.js");
  assert.equal(tr.full_title, "counter fails only in the second run");
  assert.equal(
    tr.native_command.join(" "),
    "npx mocha --fgrep counter fails only in the second run test/counter.test.js",
  );
  const loc = f.locations[0];
  assert.equal(loc?.path, "test/counter.test.js");
  assert.notEqual(loc.start, null, "the line of the failed assertion");

  const count = s.metrics.find(
    (m) => m.check_id === "tests.flaky" && m.name === "flaky_tests",
  );
  assert.equal(count?.value, 1);
  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("a test that fails in every run is a failed test and not a Flaky test", async (t) => {
  const original = copyProject(t, "flaky-test");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "tests.existing,tests.flaky",
  ]);

  assert.equal(r.code, 1, `the test that always fails is a Gate\n${r.stderr}`);
  const s = full(r);
  const gates = findingsOf(s, "tests.existing").filter((f) => f.gate);
  assert.equal(
    gates.length,
    1,
    "the first run is the only one tests.existing reports",
  );
  assert.ok(
    gates[0]?.title.includes("counter fails in every run"),
    gates[0]?.title,
  );
  for (const f of flakyFindingsOf(s)) {
    assert.ok(
      !f.title.includes("fails in every run") &&
        !f.title.includes("passes in every run"),
      `not flaky: ${f.title}`,
    );
  }
  // The first run is the reference: the test that fails only in the second
  // run passed there, so the pass rate sees two of three tests.
  assert.equal(s.inventory.tests.length, 1);
  const inv = s.inventory.tests[0];
  assert.equal(inv?.found, 3);
  assert.equal(inv.passed, 2);
  assert.equal(inv.failed, 1, "the counts of the first run only");
  // Repeat runs are not measured: tests.coverage and runtime.warnings are not
  // selected here, and the suite's logs of the repeat runs belong to
  // tests.flaky.
  const logs = s.artifacts.filter(
    (a) => a.check_id === "tests.flaky" && a.path.includes("test-output-run"),
  );
  assert.equal(
    logs.length,
    2,
    `tests.flaky repeat-run logs: ${JSON.stringify(s.artifacts)}`,
  );
  assertNothingLeft(r);
});

test("repeat runs do not change the coverage or the warnings of the first run", async (t) => {
  const original = copyProject(t, "flaky-test");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "tests.existing,tests.coverage,runtime.warnings,tests.flaky",
  ]);

  const s = full(r);
  for (const check of ["tests.coverage", "runtime.warnings", "tests.flaky"]) {
    assert.equal(oneExecution(s, check).status, "completed", check);
  }
  assert.equal(flakyFindingsOf(s).length, 1);
  assertNothingLeft(r);
});

test("the Benchmark scores Flaky tests as a part of the Tests area and keeps the pass rate on the first run", async (t) => {
  const original = copyProject(t, "flaky-test");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "package.install,tests.existing,tests.smells,tests.flaky",
  ]);

  const s = full(r);
  const part = (id: string) => {
    for (const a of s.benchmark?.areas ?? []) {
      const p = a.parts.find((x) => x.id === id);
      if (p) return p;
    }
    return assert.fail(`no Benchmark part ${id}`);
  };
  const flaky = part("flaky_tests");
  assert.equal(flaky.state, "measured");
  assert.equal(flaky.raw_value, 1);
  assert.equal(flaky.score, 79.4, "one Flaky test: 100 * 2^(-1/3) = 79.4");
  const pass = part("pass_rate");
  assert.equal(pass.state, "measured");
  assert.ok(
    pass.score !== null && pass.score >= 66.6 && pass.score <= 66.7,
    `pass rate ${String(pass.score)}: 2 of 3 tests of the first run`,
  );
  const tests = s.benchmark?.areas.find((a) => a.id === "tests");
  assert.ok(
    tests?.score === null || tests?.score === undefined || tests.score < 100,
    JSON.stringify(tests),
  );
  assertNothingLeft(r);
});

test("a clean project has no Flaky test", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", "tests.flaky"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(oneExecution(s, "tests.flaky").status, "completed");
  assert.deepEqual(findingsOf(s, "tests.flaky"), []);
  assertNothingLeft(r);
});

test("every repeat run gets fresh Services", async (t) => {
  // The tests of valkey-service need an empty Valkey. If a repeat run reused
  // the Service of the run before, "starts empty" would fail there and show
  // as a Flaky test.
  const original = copyProject(t, "valkey-service");

  const r = await realRun(t, ["test", original, "--only", "tests.flaky"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  for (const e of executionsOf(s, "tests.flaky")) {
    assert.equal(e.status, "completed", JSON.stringify(e));
  }
  assert.deepEqual(
    findingsOf(s, "tests.flaky"),
    [],
    "every run had an empty Valkey",
  );
  assertNothingLeft(r);
});
