// Settings that hide results (Go: test_report_visibility_test.go): bail is
// switched off and the Report says when the project's configuration had set
// it, every retry attempt is recorded, and a count the reporter could not
// see in full is marked as a lower bound.
import assert from "node:assert/strict";
import { test } from "node:test";

import { TestFailed } from "../resultset/types.ts";
import { parseTestEvents } from "./test_events.ts";
import {
  caseOf,
  endOfSuite,
  foundAdd,
  limitationsOfCode,
  lines,
  mochaNative,
  passedAdd,
  results,
  suiteInput,
} from "./test_report.testutil.ts";
import { eventLimitations } from "./test_visibility.ts";

test("a bail setting of the project's config is listed as an override", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const ev = parseTestEvents(
    lines(`{"ev":"config","bail":true}`, foundAdd, passedAdd, endOfSuite),
  );

  const got = limitationsOfCode(
    { limitations: eventLimitations(input, ev) },
    "test_command_override",
  );

  assert.equal(got.length, 1);
  const [l] = got;
  assert.ok(l);
  assert.ok(l.message.includes("bail"));
  assert.ok(l.message.includes("configuration"));
  assert.equal(l.check_id, "tests.existing");
  assert.equal(l.path, "package.json");
});

test("no override is listed when the project's config does not set bail or says nothing", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  for (const [name, data] of [
    [
      "bail false",
      lines(`{"ev":"config","bail":false}`, foundAdd, passedAdd, endOfSuite),
    ],
    ["no config event", lines(foundAdd, passedAdd, endOfSuite)],
    ["no events at all", null],
  ] as const) {
    assert.deepEqual(eventLimitations(input, parseTestEvents(data)), [], name);
  }
});

test("a count that Mocha could not see is marked as a lower bound with a Limitation", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const ev = parseTestEvents(
    lines(`{"ev":"partial","reason":"parallel"}`, passedAdd, endOfSuite),
  );

  const got = limitationsOfCode(
    { limitations: eventLimitations(input, ev) },
    "test_counts_lower_bound",
  );

  assert.equal(got.length, 1);
  assert.equal(got[0]?.check_id, "tests.existing");
  assert.ok(got[0].message.includes("lower bound"));
  assert.ok(got[0].message.includes("parallel"));
});

test("every retry attempt is recorded and a test that fails after retries keeps them all", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    mochaNative,
    foundAdd,
    `{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"attempt 1"}}`,
    `{"ev":"retry","id":1,"duration":5,"err":{"name":"Error","message":"attempt 2"}}`,
    `{"ev":"result","id":1,"outcome":"failed","duration":6,"err":{"name":"Error","message":"attempt 3"}}`,
    endOfSuite,
  );

  const c = caseOf(r, "add adds").testCase;
  assert.equal(c.outcome, TestFailed);
  assert.equal(c.flaky, false);
  assert.deepEqual(c.attempts, [
    { outcome: TestFailed, duration_ms: 4, error: "attempt 1" },
    { outcome: TestFailed, duration_ms: 5, error: "attempt 2" },
    { outcome: TestFailed, duration_ms: 6, error: "attempt 3" },
  ]);
  assert.equal(
    r.findings.length,
    1,
    "a test that fails after its retries is one Finding",
  );
});
