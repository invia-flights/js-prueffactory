import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "./finalize.ts";
import {
  artifactByID,
  at,
  goOracle,
  handMade,
  testCase,
} from "./helpers.testutil.ts";
import { TestFailed, TestPassed, TestSkipped } from "./types.ts";
import { validate } from "./validate.ts";

test("finalize moves passed test cases to an artifact referenced by the execution", () => {
  const s = handMade();
  s.test_cases = [
    testCase("test/b.js", "b works", TestPassed),
    testCase("test/a.js", "a works", TestPassed),
    testCase("test/a.js", "a fails", TestFailed),
    testCase("test/a.js", "a is skipped", TestSkipped),
  ];
  finalize(s);

  assert.equal(
    s.test_cases.length,
    2,
    "report.json keeps the failed and the skipped one",
  );
  for (const tc of s.test_cases) {
    assert.notEqual(
      tc.outcome,
      TestPassed,
      `passed test case ${tc.full_title} stayed in the list`,
    );
  }
  assert.equal(s.summary.test_cases.passed, 2);
  assert.equal(s.summary.test_cases.failed, 1);
  assert.equal(s.summary.test_cases.skipped, 1);
  const exec = at(s.checks, 0); // tmp-a became E-0001
  assert.equal(
    exec.artifact_ids.length,
    1,
    "the execution lists the passed-tests file",
  );
  const a = artifactByID(s, at(exec.artifact_ids, 0));
  assert.ok(a?.content);
  assert.equal(a.media_type, "application/json");
  assert.ok(a.path.startsWith("artifacts/tests/"), a.path);
  const body = Buffer.from(a.content).toString("utf8");
  assert.ok(
    body.includes("a works") &&
      body.indexOf("a works") < body.indexOf("b works"),
    body,
  );
  assert.ok(
    !body.includes("a fails"),
    "a failed case leaked into the passed-tests artifact",
  );
  assert.deepEqual(validate(s), []);
  // A second finalize must neither lose nor double the counts.
  finalize(s);
  assert.equal(s.summary.test_cases.passed, 2);
  assert.equal(s.artifacts.length, 1);
});

test("the passed-tests artifact is the JSON the Go build writes, HTML escaped", () => {
  const s = handMade();
  const second = testCase(
    "test/a.js",
    'line\u2028sep \u0007 "q" \\ \u{1F600}',
    TestPassed,
  );
  second.flaky = true;
  second.attempts = [
    { outcome: TestFailed, duration_ms: 2, error: "boom\n\tat x" },
    { outcome: TestPassed, duration_ms: 3, error: null },
  ];
  s.test_cases = [testCase("test/<a>.js", "a & b <c>", TestPassed), second];
  finalize(s);
  const a = at(s.artifacts, 0);
  assert.equal(a.path, goOracle.passedTestsArtifact.path);
  assert.ok(a.content);
  assert.equal(
    Buffer.from(a.content).toString("utf8"),
    goOracle.passedTestsArtifact.content,
  );
});
