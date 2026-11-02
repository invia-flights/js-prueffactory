// Seam A tests of tests.existing for Mocha settings that would hide results:
// bail, retries and .only. The Report shows every failure, every retry attempt
// and the tests a .only excluded (Go: tests_existing_visibility_docker_test.go).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  counts,
  findingsOf,
  full,
  inventoryOf,
  oneExecution,
  overrideMessages,
  passedCasesOf,
  removeFile,
  testCasesOf,
  writeFiles,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("bail in the project's config is switched off and every failure and retry attempt is recorded", async (t) => {
  const original = copyProject(t, "bail-and-retries");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "failed");
  // The project's config says bail: true, and the Report lists the override.
  assert.ok(overrideMessages(s).includes("configuration sets bail"));
  // Both failures are Findings, although the first one would have stopped the run.
  const titles = findingsOf(s, existing).map((f) => f.title);
  assert.equal(titles.length, 2, JSON.stringify(titles));
  const joined = titles.join("");
  assert.ok(joined.includes("failures fails first"), joined);
  assert.ok(joined.includes("failures fails on every attempt"), joined);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 5, run: 5, passed: 3, failed: 2 }),
  );
  // A test that failed after its retries keeps every attempt.
  const retried = testCasesOf(s, e.id).find(
    (c) => c.full_title === "failures fails on every attempt",
  );
  assert.ok(retried);
  assert.equal(retried.outcome, "failed");
  assert.equal(retried.flaky, false);
  assert.equal(retried.attempts.length, 3);
  for (const a of retried.attempts) {
    assert.equal(a.outcome, "failed");
    assert.ok(
      a.error?.includes("Expected values to be strictly equal"),
      JSON.stringify(a),
    );
  }
  // A test that passed on its second attempt is passed, flaky and has both attempts.
  let flaky = 0;
  for (const p of passedCasesOf(r, s, e)) {
    if (p.full_title === "flaky passes only on its second attempt") {
      flaky++;
      assert.ok(p.flaky);
      assert.equal(p.attempts.length, 2);
      assert.equal(p.attempts[0]?.outcome, "failed");
      assert.notEqual(p.attempts[0].error, null);
      assert.equal(p.attempts[1]?.outcome, "passed");
    } else {
      assert.equal(p.flaky, false, p.full_title);
      assert.equal(p.attempts.length, 1, p.full_title);
    }
  }
  assert.equal(flaky, 1);
  assertNothingLeft(r);
});

test("bail in a JavaScript config is switched off and listed", async (t) => {
  const original = copyProject(t, "bail-and-retries");
  removeFile(original, ".mocharc.json");
  writeFiles(original, {
    ".mocharc.cjs":
      "'use strict';\n\nmodule.exports = { spec: ['test/**/*.test.js'], bail: true, exit: true };\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  assert.ok(overrideMessages(s).includes("configuration sets bail"));
  const e = oneExecution(s, existing);
  const got = inventoryOf(s, e.context_id);
  assert.equal(got.failed, 2, "every test ran in spite of bail");
  assert.equal(got.found, 5);
  assertNothingLeft(r);
});

test("no bail override is listed when the project does not set bail", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.ok(!overrideMessages(full(r)).includes("configuration sets bail"));
  assertNothingLeft(r);
});

test("tests excluded by a committed .only are found and never run, and the focused one is counted", async (t) => {
  const original = copyProject(t, "committed-only");

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed", r.stderr);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, {
      found: 4,
      run: 1,
      passed: 1,
      focused: 1,
      never_run: 3,
    }),
  );
  const cases = testCasesOf(s, e.id);
  assert.equal(cases.length, 3, "the three tests the .only excluded");
  for (const tc of cases) {
    assert.equal(tc.outcome, "never_run", tc.full_title);
    assert.ok(tc.never_run_reason?.includes(".only"), tc.full_title);
  }
  // Mocha's own filter ran after the reporter was built, so nothing is guessed.
  assert.deepEqual(
    s.limitations.filter((l) => l.reason_code === "test_counts_lower_bound"),
    [],
    "every test was seen",
  );
  assertNothingLeft(r);
});

test("in parallel mode the counts are marked as lower bounds with a Limitation", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    ".mocharc.json": `{"spec":["test/**/*.test.js"],"parallel":true}` + "\n",
    "test/second.test.js":
      "'use strict';\n\ndescribe('second', () => {\n  it('also passes', () => {});\n});\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  const got = inventoryOf(s, e.context_id);
  assert.equal(got.run, 2);
  assert.equal(got.passed, 2);
  const found = s.limitations.find(
    (l) => l.reason_code === "test_counts_lower_bound",
  );
  assert.ok(found, JSON.stringify(s.limitations));
  assert.ok(found.message.includes("lower bound"));
  assert.equal(found.check_id, existing);
  assertNothingLeft(r);
});

// The reporter reads the project's bail setting through Mocha's own option
// loader, which moved in Mocha 12, and follows retried tests through clones.
describe("bail and retries work on every supported Mocha major", () => {
  for (const major of ["9", "10", "11", "12"]) {
    test(`mocha ${major}`, async (t) => {
      const original = copyProject(t, "bail-and-retries");
      writeFiles(original, {
        "package.json":
          `{"name":"bail-and-retries","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"^${major}"}}` +
          "\n",
      });
      removeFile(original, "package-lock.json");

      const r = await realRun(t, ["test", original, "--only", existing]);

      const s = full(r);
      const e = oneExecution(s, existing);
      assert.equal(e.status, "completed", r.stderr);
      assert.ok(overrideMessages(s).includes("configuration sets bail"));
      assert.deepEqual(
        inventoryOf(s, e.context_id),
        counts(e.context_id, { found: 5, run: 5, passed: 3, failed: 2 }),
      );
      const flaky = passedCasesOf(r, s, e).filter(
        (p) => p.flaky && p.attempts.length === 2,
      ).length;
      assert.equal(flaky, 1, "flaky passed cases");
      assertNothingLeft(r);
    });
  }
});
