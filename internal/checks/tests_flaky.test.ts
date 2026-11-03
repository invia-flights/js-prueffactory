// Seam B for tests.flaky: what the runs of a suite leave behind goes in, the
// Check's Result comes out. The containers are stubbed (useRunTestSuite);
// the Docker tests of the cli package cover the real runs (Go:
// tests_flaky_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { background, withCancel, withTimeout } from "../gocompat/context.ts";
import { millisecond } from "../gocompat/time.ts";
import {
  NotApplicable,
  SeverityNote,
  SeverityWarning,
  StatusBlocked,
  StatusCompleted,
  StatusInfrastructureError,
  StatusPartial,
  StatusUnsupported,
  TrustUntrusted,
} from "../resultset/types.ts";
import { AreaTests, lookup } from "./catalog.ts";
import { addWarningsEnv } from "./runtime_warnings.ts";
import {
  endOfSuite,
  finishedSuite,
  foundAdd,
  foundSub,
  lines,
  passedAdd,
  passedSub,
  selectionWithout,
  suiteInput,
  twoSuiteInput,
} from "./test_report.testutil.ts";
import { parseTestEvents } from "./test_events.ts";
import { testsExisting, testsExistingID } from "./tests_existing.ts";
import { testsFlakyID } from "./tests_flaky.ts";
import {
  checkOf,
  cutRunWith,
  failedAdd,
  flakyFindings,
  flakyInput,
  metricValue,
  retryAdd,
  ruleOf,
  runCheck,
  skippedAd,
  stubRuns,
  suiteRunWith,
  threeRuns,
  todoAdd,
  untilAborted,
} from "./tests_flaky.testutil.ts";
import { wantsCoverage } from "./tests_coverage.ts";
import {
  forRepeat,
  testArtifactCheck,
  testLogPath,
  testLogStem,
  useRepeatRunTimeout,
} from "./tests_repeat.ts";

const okRun = (input: Parameters<typeof suiteRunWith>[0]) =>
  suiteRunWith(input, passedAdd, passedSub);

test("tests.flaky is implemented and applies where tests.existing applies", (t) => {
  const e = lookup(testsFlakyID);
  assert.ok(e);
  assert.equal(e.status, "implemented");
  assert.equal(e.canFireGates, false);
  assert.equal(e.area, AreaTests);

  const input = suiteInput(t, { "test/add.test.js": "x" });
  const [want, wantWhy] = testsExisting.applicability(
    input.project,
    input.context,
  );
  const check = checkOf(testsFlakyID);
  const [got, why] = check.applicability(input.project, input.context);
  assert.equal(got, want, `${why} vs ${wantWhy}`);
  const root = input.project.contexts[0];
  assert.ok(root);
  assert.equal(check.applicability(input.project, root)[0], NotApplicable);
  assert.ok(input.context.package);
  input.context.package.tests = null;
  assert.equal(
    check.applicability(input.project, input.context)[0],
    NotApplicable,
  );
});

test("each suite runs two more times after the shared first run, one after another", async (t) => {
  const input = flakyInput(t);
  const order = threeRuns(t, okRun, okRun, okRun);

  // tests.existing performs the first run; tests.flaky reads it.
  await testsExisting.run(background(), input);
  const res = await runCheck(testsFlakyID, input);

  assert.equal(
    order.join(" "),
    "scripts.test#1 scripts.test#2 scripts.test#3",
    "the first run once, then two repeats in sequence",
  );
  assert.equal(res.status, StatusCompleted);
  assert.equal(res.findings, undefined);
  assert.equal(metricValue(res, "flaky_tests"), 0);
});

test("the first run runs even when tests.existing is not selected", async (t) => {
  const input = flakyInput(t);
  input.selection = selectionWithout(testsExistingID);
  const order = threeRuns(t, okRun, okRun, okRun);

  await runCheck(testsFlakyID, input);

  assert.equal(order.join(" "), "scripts.test#1 scripts.test#2 scripts.test#3");
});

test("a test that passes, fails and passes is one Flaky test with the outcome of each run", async (t) => {
  const input = flakyInput(t);
  threeRuns(t, okRun, (i) => suiteRunWith(i, failedAdd, passedSub), okRun);

  const res = await runCheck(testsFlakyID, input);

  const fs = flakyFindings(res);
  assert.equal(fs.length, 1, JSON.stringify(res.findings));
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.check_id, testsFlakyID);
  assert.equal(f.severity, SeverityWarning);
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.gate, false);
  assert.equal(f.suite, "scripts.test");
  assert.equal(f.title, "Flaky test: add adds (runs: passed, failed, passed)");
  // The test title is the project's text: it stands in the Message as a code span.
  assert.ok(
    f.message.startsWith("The test `add adds` passed in run 1, 3 and failed"),
    f.message,
  );
  assert.deepEqual(
    f.evidence.map((e) => e.text),
    [
      "run 1 (first run): passed",
      "run 2: failed\n  attempt 1 (final): failed: counter was 2 and not 1",
      "run 3: passed",
    ],
  );
  for (const e of f.evidence) {
    assert.equal(e.trust, TrustUntrusted);
  }
  assert.equal(f.locations.length, 1);
  assert.equal(f.locations[0]?.path, "test/add.test.js");
  assert.equal(f.locations[0].start?.line, 11);
  const tr = f.reproduction.test;
  assert.ok(tr);
  assert.equal(tr.full_title, "add adds");
  assert.equal(tr.file, "test/add.test.js");
  assert.equal(
    tr.native_command.join(" "),
    "npx mocha --fgrep add adds test/add.test.js",
  );
  assert.equal(metricValue(res, "flaky_tests"), 1);
});

test("a test that fails in every run is a failed test and not a Flaky test", async (t) => {
  const input = flakyInput(t);
  const failing = (i: typeof input) => suiteRunWith(i, failedAdd, passedSub);
  threeRuns(t, failing, failing, failing);

  const res = await runCheck(testsFlakyID, input);

  assert.equal(res.findings, undefined, "tests.existing reports the failure");
});

test("a test that never ran through a failed hook counts as failed in the comparison", async (t) => {
  const input = flakyInput(t);
  const hook = `{"ev":"hook_fail","title":"\\"before all\\" hook","hookType":"before all","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"no connection"}}`;
  threeRuns(t, okRun, (i) => suiteRunWith(i, hook), okRun);

  const res = await runCheck(testsFlakyID, input);

  const fs = flakyFindings(res);
  assert.equal(fs.length, 2, "both tests the hook kept from running");
  assert.ok(
    fs[0]?.evidence[1]?.text.startsWith("run 2: never run"),
    fs[0]?.evidence[1]?.text,
  );
});

test("a test that only passed after Mocha retries is flaky even when every run passes", async (t) => {
  const input = flakyInput(t);
  threeRuns(
    t,
    (i) => suiteRunWith(i, retryAdd, passedAdd, passedSub),
    okRun,
    okRun,
  );

  const res = await runCheck(testsFlakyID, input);

  const fs = flakyFindings(res);
  assert.equal(fs.length, 1, JSON.stringify(res.findings));
  assert.equal(
    fs[0]?.evidence[0]?.text,
    "run 1 (first run): passed after 2 attempts\n  attempt 1: failed: socket hang up\n  attempt 2 (final): passed",
  );
  assert.ok(fs[0].title.includes("passed after 2 attempts"), fs[0].title);
  assert.ok(
    fs[0].message.startsWith(
      "The test `add adds` only passed after Mocha retried it, in run 1. ",
    ),
    fs[0].message,
  );
});

test("skipped and todo tests take part in no comparison", async (t) => {
  const input = flakyInput(t);
  threeRuns(
    t,
    (i) => suiteRunWith(i, skippedAd, passedSub),
    okRun,
    (i) => suiteRunWith(i, todoAdd, passedSub),
  );

  const res = await runCheck(testsFlakyID, input);

  assert.equal(res.findings, undefined);
});

test("a test found in only some runs is a note and not a Flaky test", async (t) => {
  const input = flakyInput(t);
  const generated = `{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"generated at load time","fullTitle":"add generated at load time","suitePath":["add"]}`;
  threeRuns(
    t,
    okRun,
    (i) =>
      finishedSuite(
        i,
        parseTestEvents(
          lines(
            foundAdd,
            foundSub,
            generated,
            passedAdd,
            passedSub,
            `{"ev":"result","id":3,"outcome":"failed","duration":1}`,
            endOfSuite,
          ),
        ),
        "",
        false,
      ),
    okRun,
  );

  const res = await runCheck(testsFlakyID, input);

  assert.equal(
    flakyFindings(res).length,
    0,
    "a test that only one run found is not flaky",
  );
  const notes = (res.findings ?? []).filter(
    (f) => ruleOf(f) === "test-in-some-runs",
  );
  assert.equal(notes.length, 1, JSON.stringify(res.findings));
  const n = notes[0];
  assert.ok(n);
  assert.equal(n.severity, SeverityNote);
  assert.equal(n.gate, false);
  assert.ok(n.title.includes("add generated at load time"), n.title);
  assert.ok(n.title.includes("found in only some runs"), n.title);
  assert.equal(
    n.message,
    "The test `add generated at load time` was found in run 2 but not in run 1, 3 of the same Snapshot. Tests that a file generates when it loads can differ between runs, so it is not reported as a Flaky test and its outcomes are not compared.",
  );
  assert.equal(metricValue(res, "flaky_tests"), 0, "the note is not counted");
});

test("notes for tests found in only some runs are capped and the cut is a Limitation", async (t) => {
  const input = flakyInput(t);
  const many = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, i) =>
        `{"ev":"found","id":${String(10 + i)},"file":"/work/test/add.test.js","title":"g${String(i)}","fullTitle":"add g${String(i)}","suitePath":["add"]}`,
    );
  threeRuns(
    t,
    okRun,
    (i) =>
      finishedSuite(
        i,
        parseTestEvents(
          lines(
            foundAdd,
            foundSub,
            ...many(53),
            passedAdd,
            passedSub,
            endOfSuite,
          ),
        ),
        "",
        false,
      ),
    okRun,
  );

  const res = await runCheck(testsFlakyID, input);

  assert.equal(
    (res.findings ?? []).filter((f) => ruleOf(f) === "test-in-some-runs")
      .length,
    50,
  );
  const l = (res.limitations ?? []).find(
    (x) => x.reason_code === "notes_truncated",
  );
  assert.ok(l);
  assert.equal(
    l.message,
    "3 more tests were found in only some runs than the 50 that are reported as notes.",
  );
  assert.equal(l.path, "package.json");
});

test("a repeat run that times out makes the execution partial and keeps the finished comparisons", async (t) => {
  t.after(useRepeatRunTimeout(20n * millisecond));
  const input = flakyInput(t);
  stubRuns(t, async (i, n, signal) => {
    if (n === 1) {
      return okRun(i);
    }
    if (n === 2) {
      // The second run got as far as the first test, which failed, and
      // waits for its limit like a real container.
      const r = cutRunWith(i, failedAdd);
      await untilAborted(signal);
      return r;
    }
    return okRun(i);
  });

  const res = await runCheck(testsFlakyID, input);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "repeat_run_timed_out");
  assert.equal(res.keepsStatus, true);
  assert.ok(
    res.reason?.startsWith(
      "Run 2 of the suite `scripts.test` ran into its time limit of 20ms.",
    ),
    res.reason,
  );
  const fs = flakyFindings(res);
  assert.equal(fs.length, 1, JSON.stringify(res.findings));
  const f = fs[0];
  assert.ok(f);
  assert.ok(f.title.includes("add adds"), f.title);
  assert.ok(f.title.includes("(runs: passed, failed, passed)"), f.title);
  for (const f of res.findings ?? []) {
    assert.ok(
      !f.title.includes("add subtracts"),
      `a test the cut run never reached is not compared: ${f.title}`,
    );
  }
});

test("the Budget ending during a repeat run makes the execution partial and stops the later runs", async (t) => {
  const input = twoSuiteInput(t);
  const ctx = withTimeout(background(), 30n * millisecond);
  t.after(() => {
    ctx.cancel();
  });
  const order = stubRuns(t, async (i, n, signal) => {
    if (n === 2 && i.suite()?.origin === "test:unit") {
      await untilAborted(signal);
      return cutRunWith(i);
    }
    return okRun(i);
  });

  const res = await runCheck(testsFlakyID, input, ctx.signal);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "budget_exhausted");
  assert.equal(res.keepsStatus, true);
  assert.equal(
    res.reason,
    "The Budget ran out during run 2 of the suite `test:unit`. The comparisons that finished are reported.",
  );
  assert.equal(
    order.join(" "),
    "test:unit#1 test:api#1 test:unit#2",
    "nothing starts once the Budget has ended",
  );
});

test("a cancelled Run leaves the status to the engine", async (t) => {
  const input = flakyInput(t);
  const ctx = withCancel();
  t.after(() => {
    ctx.cancel();
  });
  stubRuns(t, (i, n) => {
    if (n === 2) {
      ctx.cancel();
      return cutRunWith(i);
    }
    return okRun(i);
  });

  const res = await runCheck(testsFlakyID, input, ctx.signal);

  assert.equal(
    res.keepsStatus,
    false,
    "a user's cancellation must reach the Report as cancelled, not as partial",
  );
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "cancelled");
});

test("every suite of a package gets its own two repeats and its Findings name the suite", async (t) => {
  const input = twoSuiteInput(t);
  const order = stubRuns(t, (i, n) =>
    n === 2 ? suiteRunWith(i, failedAdd, passedSub) : okRun(i),
  );

  const res = await runCheck(testsFlakyID, input);

  assert.equal(
    order.join(" "),
    "test:unit#1 test:api#1 test:unit#2 test:unit#3 test:api#2 test:api#3",
  );
  const fs = flakyFindings(res);
  assert.equal(fs.length, 2, "one per suite");
  assert.equal(fs[0]?.suite, "test:unit");
  assert.equal(fs[1]?.suite, "test:api");
  assert.notEqual(fs[0].fingerprint, fs[1].fingerprint);
});

test("a suite that could not start gets no repeats and the Check reports why", async (t) => {
  const input = flakyInput(t);
  const order = stubRuns(t, () => ({
    status: StatusBlocked,
    reasonCode: "service_unavailable",
    reason: "no Valkey",
  }));

  const res = await runCheck(testsFlakyID, input);

  assert.equal(order.length, 1);
  assert.equal(res.status, StatusBlocked);
  assert.equal(res.reasonCode, "service_unavailable");
  assert.equal(res.reason, "no Valkey");
});

test("a suite that did not run in a completed first run is a Limitation", async (t) => {
  const input = flakyInput(t);
  stubRuns(t, () => ({ status: StatusCompleted }));

  const res = await runCheck(testsFlakyID, input);

  assert.equal(res.status, StatusCompleted);
  assert.deepEqual(res.limitations, [
    {
      reason_code: "tests_not_run",
      check_id: testsFlakyID,
      path: null,
      message:
        "The test suite did not run, so there is nothing to repeat. tests.existing says why.",
    },
  ]);
});

test("an unsupported package is unsupported and runs nothing", async (t) => {
  const input = flakyInput(t);
  assert.ok(input.context.package?.tests);
  input.context.package.tests = {
    ...input.context.package.tests,
    unsupported: {
      code: "test_runner_not_implemented",
      reason: "tests run by jest are not supported yet",
    },
  };
  const order = stubRuns(t, () => ({ status: StatusCompleted }));

  const res = await runCheck(testsFlakyID, input);

  assert.equal(order.length, 0);
  assert.equal(res.status, StatusUnsupported);
  assert.equal(res.reasonCode, "test_runner_not_implemented");
});

test("a repeat run that fails to start makes the execution partial", async (t) => {
  const input = flakyInput(t);
  threeRuns(
    t,
    okRun,
    () => ({
      status: StatusInfrastructureError,
      reasonCode: "service_not_ready",
      reason: "Service cache did not come up",
    }),
    (i) => suiteRunWith(i, failedAdd, passedSub),
  );

  const res = await runCheck(testsFlakyID, input);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "repeat_run_failed");
  assert.equal(
    res.reason,
    "Run 2 of the suite `scripts.test` did not run: Service cache did not come up",
  );
  const fs = flakyFindings(res);
  assert.equal(fs.length, 1, JSON.stringify(res.findings));
  assert.ok(
    fs[0]?.title.includes("(runs: passed, failed)"),
    `the finished comparison is kept, with the runs that took part: ${fs[0]?.title ?? ""}`,
  );
});

// --- what makes a run a repeat run ---

test("a repeat run gets container names of its own and no coverage and no warning flags", (t) => {
  const input = flakyInput(t);
  const rep = forRepeat(input, {
    checkID: testsFlakyID,
    number: 2,
    nodeOptions: "",
  });

  assert.notEqual(rep.suiteSuffix(), input.suiteSuffix());
  assert.ok(
    rep.suiteSuffix().startsWith(input.suiteSuffix()),
    `${rep.suiteSuffix()} and ${input.suiteSuffix()} must differ, so Services and networks are fresh`,
  );
  const two = forRepeat(input, {
    checkID: testsFlakyID,
    number: 3,
    nodeOptions: "",
  });
  assert.notEqual(two.suiteSuffix(), rep.suiteSuffix());
  assert.equal(wantsCoverage(input), true);
  assert.equal(wantsCoverage(rep), false);
  const env: Record<string, string> = { NODE_OPTIONS: "--require ./setup.js" };
  const marker = addWarningsEnv(rep, env);
  assert.equal(
    env.NODE_OPTIONS,
    "--require ./setup.js",
    "the project's value without our warning flags",
  );
  assert.equal(env.JSPF_END_MARKER, marker.text, "a repeat run is watched too");
});

test("a repeat run can add to NODE_OPTIONS after the project's value", (t) => {
  const input = forRepeat(flakyInput(t), {
    checkID: testsFlakyID,
    number: 2,
    nodeOptions: "--unhandled-rejections=strict",
  });
  const env: Record<string, string> = { NODE_OPTIONS: "--require ./setup.js" };
  addWarningsEnv(input, env);
  assert.equal(
    env.NODE_OPTIONS,
    "--require ./setup.js --unhandled-rejections=strict",
  );
});

test("the command log of a repeat run belongs to the Check that ran it", (t) => {
  const input = flakyInput(t);
  assert.equal(
    testLogPath(input),
    `artifacts/tests.existing/${input.context.id}/test-output.log`,
  );
  const rep = forRepeat(input, {
    checkID: testsFlakyID,
    number: 3,
    nodeOptions: "",
  });
  assert.equal(
    testLogPath(rep),
    `artifacts/tests.flaky/${input.context.id}/test-output-run3.log`,
  );
});

test("the other files of a run, such as the reporter's event file, are named like its command log and belong to the same Check", (t) => {
  const input = twoSuiteInput(t).forSuite(1);
  assert.deepEqual(
    [testArtifactCheck(input), testLogStem(input)],
    ["tests.existing", "test-output-2-test-api"],
  );
  const rep = forRepeat(input, {
    checkID: testsFlakyID,
    number: 4,
    nodeOptions: "",
  });
  assert.deepEqual(
    [testArtifactCheck(rep), testLogStem(rep)],
    ["tests.flaky", "test-output-2-test-api-run4"],
  );
});

test("the command log of a repeat run of a package with several suites names the suite and the run", (t) => {
  const input = twoSuiteInput(t).forSuite(1);
  const rep = forRepeat(input, {
    checkID: testsFlakyID,
    number: 2,
    nodeOptions: "",
  });
  assert.equal(
    testLogPath(rep),
    `artifacts/tests.flaky/${input.context.id}/test-output-2-test-api-run2.log`,
  );
});
