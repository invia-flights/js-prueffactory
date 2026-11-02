// Seam B for node:test suites (Go: test_report_nodetest_test.go): the event
// lines of js/node-test-reporter.js go in, the same test cases, Findings and
// counts as for Mocha come out. The Docker tests check the lines against a
// real `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfidenceConfirmed,
  SeverityError,
  TestNeverRun,
  TestPassed,
  TestSkipped,
  TestTodo,
} from "../resultset/types.ts";
import {
  caseOf,
  endOfSuite,
  failedSub,
  findingOf,
  foundAdd,
  foundSub,
  nodeNative,
  nodeTestInput,
  passedAdd,
  results,
} from "./test_report.testutil.ts";

test("a failed node test is a Gate Finding with the node:test re-run command", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    foundAdd,
    foundSub,
    passedAdd,
    failedSub,
    endOfSuite,
  );

  const f = findingOf(r, "test-failed");
  assert.deepEqual(f.reproduction.test, {
    runner: "node:test",
    file: "test/add.test.js",
    full_title: "add subtracts",
    native_command: [
      "node",
      "--test",
      "--test-name-pattern=^add subtracts$",
      "test/add.test.js",
    ],
  });
  for (const e of f.evidence) {
    assert.equal(e.origin, "node:test", e.kind);
  }
});

test("the name of a node test is escaped in its pattern and cannot inject options", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    `{"ev":"found","file":"/work/-r evil.js","title":"a.b (1+1) [x] {y} $ ^ | \\\\ *","fullTitle":"--require evil a.b (1+1) [x] {y} $ ^ | \\\\ *","suitePath":["--require evil"]}`,
    `{"ev":"result","file":"/work/-r evil.js","fullTitle":"--require evil a.b (1+1) [x] {y} $ ^ | \\\\ *","outcome":"failed","duration":1,"err":{"name":"Error","message":"x"}}`,
    endOfSuite,
  );

  assert.deepEqual(
    findingOf(r, "test-failed").reproduction.test?.native_command,
    [
      "node",
      "--test",
      "--test-name-pattern=^--require evil a\\.b \\(1\\+1\\) \\[x\\] \\{y\\} \\$ \\^ \\| \\\\ \\*$",
      "./-r evil.js",
    ],
  );
});

test("node:test todo and skipped tests are counted apart from passed ones", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    foundAdd,
    foundSub,
    `{"ev":"found","id":3,"file":"/work/test/add.test.js","title":"later","fullTitle":"add later","suitePath":["add"]}`,
    passedAdd,
    `{"ev":"result","id":2,"outcome":"todo","duration":1,"err":{"name":"Error","message":"not yet"}}`,
    `{"ev":"result","id":3,"outcome":"skipped","duration":0}`,
    endOfSuite,
  );

  assert.equal(r.findings.length, 0, "a todo test that fails is not a Finding");
  assert.equal(caseOf(r, "add subtracts").testCase.outcome, TestTodo);
  assert.equal(caseOf(r, "add later").testCase.outcome, TestSkipped);
  assert.deepEqual(r.inventory, {
    context_id: input.context.id,
    found: 3,
    run: 1,
    passed: 1,
    failed: 0,
    skipped: 1,
    todo: 1,
    focused: 0,
    never_run: 0,
  });
});

test("a failed beforeEach hook of node:test is one Finding and its tests never ran", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const hook = `{"ev":"hook_fail","title":"\\"beforeEach\\" hook","hookType":"beforeEach","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"beforeEach broke","stack":"Error: beforeEach broke\\n    at TestContext.<anonymous> (/work/test/add.test.js:4:9)"}}`;
  const r = results(
    input,
    nodeNative,
    foundAdd,
    foundSub,
    hook,
    hook,
    endOfSuite,
  );

  assert.equal(r.findings.length, 1, "one Finding for the hook");
  const f = findingOf(r, "hook-failed");
  assert.equal(f.reproduction.test?.runner, "node:test");
  assert.deepEqual(f.reproduction.test.native_command, [
    "node",
    "--test",
    "test/add.test.js",
  ]);
  const c = caseOf(r, "add adds");
  assert.equal(c.testCase.outcome, TestNeverRun);
  assert.ok(c.testCase.never_run_reason?.includes("beforeEach"));
  assert.deepEqual(c.findings, [0]);
});

test("a node test file that fails to load is a Gate Finding with its error", (t) => {
  const input = nodeTestInput(t, {
    "test/add.test.js": "x",
    "test/broken.test.js": "x",
  });
  const r = results(
    input,
    nodeNative,
    foundAdd,
    passedAdd,
    `{"ev":"file_fail","file":"/work/test/broken.test.js","err":{"name":"Error","message":"test failed"},"text":"Error: Cannot find module './missing'\\nRequire stack:\\n- /work/test/broken.test.js\\n    at Object.<anonymous> (/work/test/broken.test.js:1:11)"}`,
    endOfSuite,
  );

  const f = findingOf(r, "test-file-load-failed");
  assert.ok(f.gate);
  assert.equal(f.severity, SeverityError);
  assert.equal(f.confidence, ConfidenceConfirmed);
  assert.equal(f.locations.length, 1);
  const [loc] = f.locations;
  assert.equal(loc?.path, "test/broken.test.js");
  assert.equal(loc.start?.line, 1);
  assert.ok(f.message.includes("Cannot find module './missing'"), f.message);
  assert.ok(f.message.includes("test/broken.test.js"));
  const text = f.evidence.find((e) => e.kind === "tool_output")?.text ?? "";
  assert.ok(text.includes("Require stack"), text);
  assert.ok(!text.includes("/work/"), text);
  assert.equal(caseOf(r, "add adds").testCase.outcome, TestPassed);
});

test("a node test file that reports nothing and prints no error is an aborted process, not a load failure", (t) => {
  const input = nodeTestInput(t, { "test/exits.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    `{"ev":"file_fail","file":"/work/test/exits.test.js","err":{"name":"Error","message":"test failed"},"text":""}`,
    endOfSuite,
  );

  const f = findingOf(r, "test-run-aborted");
  assert.ok(f.gate);
  assert.ok(f.message.includes("process.exit()"));
  assert.equal(f.locations[0]?.path, "test/exits.test.js");
});

test("a node test file whose process stops midway leaves its unfinished tests never run", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    foundAdd,
    foundSub,
    passedAdd,
    `{"ev":"file_fail","file":"/work/test/add.test.js","err":{"name":"Error","message":"test failed"},"text":""}`,
    endOfSuite,
  );

  const f = findingOf(r, "test-run-aborted");
  assert.ok(f.gate);
  assert.ok(f.message.includes("test/add.test.js"));
  const c = caseOf(r, "add subtracts").testCase;
  assert.equal(c.outcome, TestNeverRun);
  assert.ok(c.never_run_reason?.includes("test/add.test.js"));
});
