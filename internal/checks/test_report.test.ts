// Seam B for the test runner step (Go: test_report_test.go): the event lines
// our reporter writes go in, test cases, Findings and Inventory counts come
// out. The event lines follow the reporter's format (js/mocha-reporter.js),
// which the Docker tests then check against a real Mocha.
import assert from "node:assert/strict";
import { test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import {
  ConfidenceConfirmed,
  KindDefect,
  SeverityError,
  TestFailed,
  TestNeverRun,
  TestPassed,
  TestSkipped,
  TrustUntrusted,
} from "../resultset/types.ts";
import { writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { parseTestEvents } from "./test_events.ts";
import {
  projectFrames,
  stackFrameMatches,
  suiteResults,
} from "./test_report.ts";
import {
  caseOf,
  endOfSuite,
  failedSub,
  findingOf,
  foundAdd,
  foundSub,
  lines,
  mochaNative,
  passedAdd,
  results,
  suiteInput,
} from "./test_report.testutil.ts";

test("a failed test is a Gate Finding with everything an agent needs to fix it", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    foundAdd,
    foundSub,
    passedAdd,
    failedSub,
    endOfSuite,
  );

  assert.equal(r.findings.length, 1);
  const f = findingOf(r, "test-failed");
  assert.ok(f.gate);
  assert.equal(f.confidence, ConfidenceConfirmed);
  assert.equal(f.severity, SeverityError);
  assert.equal(f.kind, KindDefect);
  assert.equal(f.check_id, "tests.existing");
  assert.equal(f.context_id, input.context.id);
  assert.equal(f.expected, "6");
  assert.equal(f.actual, "5");
  assert.equal(f.locations.length, 1);
  const [loc] = f.locations;
  assert.equal(loc?.path, "test/add.test.js");
  assert.deepEqual(loc.start, { line: 9, column: 12 });
  assert.ok(f.title.includes("add subtracts"));
  assert.ok(f.message.includes("5 !== 6"));
  // The stack is Evidence, with container paths shown relative to the package.
  let stack = "";
  for (const e of f.evidence) {
    if (e.kind === "stack_trace") stack = e.text;
    assert.equal(e.trust, TrustUntrusted, `evidence ${e.kind}`);
  }
  assert.ok(stack.includes("(test/add.test.js:9:12)"), stack);
  assert.ok(!stack.includes("/work/"));
  // Re-running: our own command, and the project's native one as argument arrays.
  assert.deepEqual(f.reproduction.rerun_command, [
    "js-prueffactory",
    "test",
    "/orig",
    "--only",
    "tests.existing",
  ]);
  assert.deepEqual(f.reproduction.test, {
    runner: "mocha",
    file: "test/add.test.js",
    full_title: "add subtracts",
    native_command: [
      "npx",
      "mocha",
      "--fgrep",
      "add subtracts",
      "test/add.test.js",
    ],
  });

  // Test cases: the passed one and the failed one, linked to the Finding.
  const failed = caseOf(r, "add subtracts");
  assert.equal(failed.testCase.outcome, TestFailed);
  assert.deepEqual(failed.findings, [0]);
  assert.equal(failed.testCase.file, "test/add.test.js");
  assert.deepEqual(failed.testCase.suite_path, ["add"]);
  assert.equal(failed.testCase.attempts.length, 1);
  const [attempt] = failed.testCase.attempts;
  assert.equal(attempt?.outcome, TestFailed);
  assert.equal(attempt.duration_ms, 5);
  assert.ok(attempt.error?.includes("5 !== 6"));
  const passed = caseOf(r, "add adds");
  assert.equal(passed.testCase.outcome, TestPassed);
  assert.deepEqual(passed.findings, []);
  assert.equal(passed.testCase.flaky, false);
  assert.deepEqual(r.inventory, {
    context_id: input.context.id,
    found: 2,
    run: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
  });
});

// Mocha shortens the paths in a stack to the folder it runs in, so a frame
// is relative to the package, not an absolute path in the container.
test("stack frames that Mocha shortened to the package folder are found", (t) => {
  const root = writeTree(t, {
    "package.json": "{}",
    "sub/package.json": `{"scripts":{"test":"mocha"}}`,
    "sub/test/a.test.js": "x",
  });
  const proj = discover(root);
  const context = proj.contexts[2];
  assert.ok(context);
  const input = new Input({
    project: proj,
    context,
    originalPath: "/orig",
    snapshotDir: root,
  });
  const r = suiteResults(
    input,
    parseTestEvents(
      lines(
        `{"ev":"found","id":1,"file":"/work/sub/test/a.test.js","title":"t","fullTitle":"s t","suitePath":["s"]}`,
        `{"ev":"result","id":1,"outcome":"failed","duration":1,"err":{"name":"Error","message":"boom","stack":"Error: boom\\n    at Context.<anonymous> (test/a.test.js:7:11)\\n    at process.processImmediate (node:internal/timers:574:21)"}}`,
        endOfSuite,
      ),
    ),
    mochaNative,
  );

  const f = findingOf(r, "test-failed");
  const [loc] = f.locations;
  assert.equal(loc?.path, "sub/test/a.test.js");
  assert.deepEqual(loc.start, { line: 7, column: 11 });
  // The re-run command runs in the package folder, so its file is relative to it.
  assert.equal(f.reproduction.test?.native_command.at(-1), "test/a.test.js");
});

test("skipped and never-run tests are counted apart from run ones", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    foundAdd,
    foundSub,
    `{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"later","fullTitle":"add later","suitePath":["add"]}`,
    passedAdd,
    `{"ev":"result","id":2,"outcome":"skipped","duration":0}`,
    endOfSuite,
  );

  const skipped = caseOf(r, "add subtracts").testCase;
  assert.equal(skipped.outcome, TestSkipped);
  assert.equal(skipped.never_run_reason, null);
  const never = caseOf(r, "add later").testCase;
  assert.equal(never.outcome, TestNeverRun);
  assert.ok((never.never_run_reason ?? "") !== "");
  assert.deepEqual(r.inventory, {
    context_id: input.context.id,
    found: 3,
    run: 1,
    passed: 1,
    failed: 0,
    skipped: 1,
    todo: 0,
    focused: 0,
    never_run: 1,
  });
});

test("a failed hook is one Finding and the tests it prevented never ran", (t) => {
  const input = suiteInput(t, {
    "test/setup.js": "x",
    "test/a.test.js": "x",
    "test/b.test.js": "x",
  });
  const r = results(
    input,
    mochaNative,
    `{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"]}`,
    `{"ev":"found","id":2,"file":"/work/test/a.test.js","title":"two","fullTitle":"a two","suitePath":["a"]}`,
    `{"ev":"found","id":3,"file":"/work/test/b.test.js","title":"three","fullTitle":"b three","suitePath":["b"]}`,
    `{"ev":"hook_fail","title":"\\"before all\\" hook in \\"{root}\\"","hookType":"before all","scope":"{root}","scopePath":[],"file":"/work/test/setup.js","err":{"name":"Error","message":"database is down","stack":"Error: database is down\\n    at Context.<anonymous> (/work/test/setup.js:4:11)"}}`,
    endOfSuite,
  );

  assert.equal(r.findings.length, 1, "a failed hook is one Finding");
  const f = findingOf(r, "hook-failed");
  assert.ok(f.gate);
  assert.equal(f.confidence, ConfidenceConfirmed);
  for (const want of ["before all", "{root}", "database is down"]) {
    assert.ok((f.title + " " + f.message).includes(want), want);
  }
  const [loc] = f.locations;
  assert.equal(loc?.path, "test/setup.js");
  assert.equal(loc.start?.line, 4);
  assert.equal(f.reproduction.test?.file, "test/setup.js");
  for (const title of ["a one", "a two", "b three"]) {
    const c = caseOf(r, title);
    assert.equal(c.testCase.outcome, TestNeverRun, title);
    const reason = c.testCase.never_run_reason ?? "";
    assert.ok(reason.includes("before all"), reason);
    assert.ok(reason.includes("database is down"), reason);
    assert.deepEqual(c.findings, [0]);
  }
  assert.equal(r.inventory.never_run, 3);
  assert.equal(r.inventory.failed, 0);
});

test("a hook only prevents the tests inside its suite", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x", "test/b.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    `{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"]}`,
    `{"ev":"found","id":2,"file":"/work/test/b.test.js","title":"two","fullTitle":"b two","suitePath":["b"]}`,
    `{"ev":"hook_fail","title":"\\"before each\\" hook for \\"one\\"","hookType":"before each","scope":"a","scopePath":["a"],"file":"/work/test/a.test.js","err":{"name":"Error","message":"boom"}}`,
    `{"ev":"result","id":2,"outcome":"passed","duration":1}`,
    endOfSuite,
  );

  const one = caseOf(r, "a one").testCase;
  assert.equal(one.outcome, TestNeverRun);
  assert.ok(one.never_run_reason?.includes(`"a"`));
  assert.equal(caseOf(r, "b two").testCase.outcome, TestPassed);
});

test("the same hook failing for several tests is one Finding", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  const hook = (name: string): string =>
    `{"ev":"hook_fail","title":"\\"after each\\" hook for \\"${name}\\"","hookType":"after each","scope":"a","scopePath":["a"],"file":"/work/test/a.test.js","err":{"name":"Error","message":"cleanup failed"}}`;
  const r = results(input, mochaNative, hook("one"), hook("two"), endOfSuite);
  assert.equal(r.findings.length, 1);
});

test("a test that passed only on retry is flaky", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    foundAdd,
    `{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"first attempt failed"}}`,
    `{"ev":"result","id":1,"outcome":"passed","duration":6}`,
    endOfSuite,
  );

  const c = caseOf(r, "add adds").testCase;
  assert.equal(c.outcome, TestPassed);
  assert.ok(c.flaky);
  assert.deepEqual(c.attempts, [
    { outcome: TestFailed, duration_ms: 4, error: "first attempt failed" },
    { outcome: TestPassed, duration_ms: 6, error: null },
  ]);
  assert.equal(r.findings.length, 0, "a test that passed is no Finding");
});

test("results survive a crash and tests not yet run are never run", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  // No end event, and the last line was cut when the process died.
  const data = Buffer.concat([
    lines(foundAdd, foundSub, passedAdd),
    Buffer.from(`{"ev":"result","id":2,"outc`),
  ]);

  const ev = parseTestEvents(data);
  const r = suiteResults(input, ev, mochaNative);

  assert.equal(caseOf(r, "add adds").testCase.outcome, TestPassed);
  const c = caseOf(r, "add subtracts").testCase;
  assert.equal(c.outcome, TestNeverRun);
  assert.ok(c.never_run_reason?.includes("stopped"));
  assert.equal(ev.ended, false, "no end event was written");
});

test("focused tests exclude the others and are counted", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    `{"ev":"found","id":1,"file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"],"focused":true}`,
    foundSub,
    `{"ev":"result","id":1,"outcome":"passed","duration":1}`,
    endOfSuite,
  );

  const c = caseOf(r, "add subtracts").testCase;
  assert.equal(c.outcome, TestNeverRun);
  assert.ok(c.never_run_reason?.includes(".only"));
  assert.equal(r.inventory.focused, 1);
  assert.equal(r.inventory.never_run, 1);
  assert.equal(r.inventory.found, 2);
});

// The Benchmark's pass rate is the mean over test files, so the Inventory
// counts the tests of each file: every kind of test found, and the passed
// ones, among them the focused ones that passed.
test("the Inventory counts the tests of each file for the pass rate", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x", "test/b.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    `{"ev":"found","id":1,"file":"/work/test/a.test.js","title":"one","fullTitle":"a one","suitePath":["a"],"focused":true}`,
    `{"ev":"found","id":2,"file":"/work/test/a.test.js","title":"two","fullTitle":"a two","suitePath":["a"]}`,
    `{"ev":"found","id":3,"file":"/work/test/b.test.js","title":"three","fullTitle":"b three","suitePath":["b"]}`,
    `{"ev":"found","id":4,"file":"/work/test/b.test.js","title":"four","fullTitle":"b four","suitePath":["b"]}`,
    `{"ev":"result","id":1,"outcome":"passed","duration":1}`,
    `{"ev":"result","id":3,"outcome":"passed","duration":1}`,
    `{"ev":"result","id":4,"outcome":"failed","duration":1,"err":{"name":"Error","message":"x","stack":"Error: x"}}`,
    endOfSuite,
  );

  const id = input.context.id;
  assert.deepEqual(r.files, [
    {
      context_id: id,
      suite: "",
      file: "test/a.test.js",
      found: 2,
      passed: 1,
      passed_focused: 1,
    },
    {
      context_id: id,
      suite: "",
      file: "test/b.test.js",
      found: 2,
      passed: 1,
      passed_focused: 0,
    },
  ]);
});

test("results without an announcement are still recorded", (t) => {
  // A parallel Mocha run does not announce its tests up front.
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    `{"ev":"result","file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"],"outcome":"passed","duration":2}`,
    endOfSuite,
  );

  const c = caseOf(r, "add adds").testCase;
  assert.equal(c.outcome, TestPassed);
  assert.equal(c.file, "test/add.test.js");
  assert.equal(r.inventory.found, 1);
  assert.equal(r.inventory.passed, 1);
});

test("titles and files that look like options cannot inject options", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    `{"ev":"found","id":1,"file":"/work/-r evil.js","title":"--require evil","fullTitle":"--require evil","suitePath":[]}`,
    `{"ev":"result","id":1,"outcome":"failed","duration":1,"err":{"name":"Error","message":"x"}}`,
    endOfSuite,
  );

  assert.deepEqual(
    findingOf(r, "test-failed").reproduction.test?.native_command,
    ["npx", "mocha", "--fgrep=--require evil", "./-r evil.js"],
  );
});

test("no events at all means Mocha never got to run any test", () => {
  const ev = parseTestEvents(null);
  assert.equal(ev.ended, false);
  assert.equal(ev.tests.length, 0);
  assert.equal(ev.started, false);
});

// --- beyond the Go tests: the parts the port had to write itself ---

test("the stack frame scan finds what Go's lazy frame pattern finds", () => {
  // Expected values worked out by hand from Go's
  // ([^\s()'"]+?):(\d+)(?::(\d+))? with FindAllStringSubmatch.
  assert.deepEqual(
    stackFrameMatches(
      "Error: x\n    at f (/work/a.js:9:12)\n    at /work/b.js:3\n at 10:5 node:internal/x:1:2 a:1b:2 :5:3 C:\\x:7",
    ),
    [
      ["/work/a.js", "9", "12"],
      ["/work/b.js", "3", ""],
      ["10", "5", ""],
      ["node:internal/x", "1", "2"],
      ["a", "1", ""],
      ["b", "2", ""],
      [":5", "3", ""],
      ["C:\\x", "7", ""],
    ],
  );
  // A long token without a frame takes linear time.
  const long = "x".repeat(4 << 20) + " /work/a.js:1:2";
  assert.deepEqual(stackFrameMatches(long), [["/work/a.js", "1", "2"]]);
});

test("frames outside the project, in node_modules or without a script extension are left out", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  assert.deepEqual(
    projectFrames(
      input,
      "at /work/node_modules/x/y.js:1:2 at file:///work/test/a.js:3:4 at http://x/a.js:1 at node:internal/a.js:1 at ../up.js:1 at 10:5 at /elsewhere/a.js:1 at test/b.ts:5",
    ),
    [
      { path: "test/a.js", line: 3, col: 4 },
      { path: "test/b.ts", line: 5, col: 0 },
    ],
  );
});
