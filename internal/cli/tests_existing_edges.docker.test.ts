// Seam A tests of tests.existing for suites that do not go as planned. Each
// starts from a copy of clean-mocha and changes it (Go:
// tests_existing_edges_docker_test.go, tests_existing_timeout_docker_test.go,
// tests_existing_versions_docker_test.go).
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
  passedTitles,
  removeFile,
  setTestScript,
  testCasesOf,
  writeFiles,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("a test file that fails to load is a Gate Finding with the error", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    "test/broken.test.js":
      "'use strict';\n\nconst missing = require('./does-not-exist');\n\ndescribe('broken', () => {\n  it('never loads', () => {});\n});\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.gate, 1);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.rule_id, "test-file-load-failed");
  assert.ok(f.gate);
  assert.equal(f.locations[0]?.path, "test/broken.test.js");
  assert.equal(f.locations[0].start?.line, 3);
  const text = f.evidence[0]?.text ?? "";
  assert.ok(text.includes("does-not-exist"), text);
  assert.ok(!text.includes("/work/"), text);
  assertNothingLeft(r);
});

test("a test that ends the process leaves the recorded results and never-run tests", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    "test/b-exits.test.js":
      "'use strict';\n\ndescribe('exits', () => {\n  it('quits the process', () => {\n    process.exit(0);\n  });\n\n  it('would run next', () => {});\n});\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]?.rule_id, "test-run-aborted");
  assert.deepEqual(
    passedTitles(r, s, e),
    ["add adds two numbers"],
    "the result recorded before the process ended is kept",
  );
  const titles = new Map<string, string>();
  for (const tc of testCasesOf(s, e.id)) {
    titles.set(tc.full_title, tc.outcome);
    if (tc.outcome === "never_run") {
      assert.ok(tc.never_run_reason?.includes("stopped"), tc.full_title);
    }
  }
  assert.equal(titles.get("exits would run next"), "never_run");
  assert.equal(titles.get("exits quits the process"), "never_run");
  assertNothingLeft(r);
});

test("a missing test runner is a Gate Finding because the project is at fault", async (t) => {
  const original = copyProject(t, "clean-mocha");
  // The project asks for Mocha in its script but never installs it.
  writeFiles(original, {
    "package.json":
      `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"}}` +
      "\n",
    "package-lock.json":
      `{"name":"clean-mocha","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"clean-mocha","version":"1.0.0"}}}` +
      "\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  const fs = findingsOf(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.equal(fs[0]?.title, "test runner not installed");
  assert.ok(fs[0].gate);
  assert.equal(fs[0].confidence, "confirmed");
  assertNothingLeft(r);
});

test("an unsupported Mocha version is reported as unsupported with the version", async (t) => {
  const original = copyProject(t, "clean-mocha");
  // No lockfile, so npm install resolves the exact old version.
  writeFiles(original, {
    "package.json":
      `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"8.4.0"}}` +
      "\n",
  });
  removeFile(original, "package-lock.json");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 2, r.stderr);
  const e = oneExecution(full(r), existing);
  assert.equal(e.status, "unsupported");
  assert.equal(e.reason_code, "test_runner_version_unsupported");
  assert.ok(e.reason?.includes("8.4.0"), e.reason ?? "");
  assertNothingLeft(r);
});

test("the script's environment reaches the tests and our reporter replaces the project's reporter and bail", async (t) => {
  const original = copyProject(t, "clean-mocha");
  setTestScript(
    original,
    "NODE_ENV=staging GREETING_FROM_SCRIPT='hello world' mocha --reporter dot --bail",
  );
  writeFiles(original, {
    "test/env.test.js": `'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

describe('the container', () => {
  it('sees the variables of the test script', () => {
    assert.strictEqual(process.env.NODE_ENV, 'staging');
    assert.strictEqual(process.env.GREETING_FROM_SCRIPT, 'hello world');
  });

  it('sees no variable of the host', () => {
    assert.strictEqual(process.env.TMPDIR, undefined);
    assert.strictEqual(process.env.XDG_STATE_HOME, undefined);
  });

  it('may write into its project folder', () => {
    fs.writeFileSync('written-by-a-test.txt', 'ok');
  });
});

describe('bail is off', () => {
  it('fails first', () => {
    assert.fail('first failure');
  });

  it('still runs after a failure', () => {});
});
`,
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  assert.ok(fs[0]?.title.includes("bail is off fails first"), fs[0]?.title);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 6, run: 6, passed: 5, failed: 1 }),
    "--no-bail keeps the tests after the failure running",
  );
  // The project's own reporter and bail are replaced, and the Report says so.
  const overrides = overrideMessages(s);
  assert.ok(overrides.includes("--reporter dot"), overrides);
  assert.ok(overrides.includes("--bail"), overrides);
  // The native command for the failure keeps the project's environment.
  const native = fs[0]?.reproduction.test?.native_command ?? [];
  assert.ok(native.length >= 5, native.join(" "));
  assert.equal(native[0], "env");
  assert.equal(native[1], "GREETING_FROM_SCRIPT=hello world");
  assert.equal(native[2], "NODE_ENV=staging");
  assertNothingLeft(r);
});

test("skipped tests are counted as skipped and are test cases", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    "test/skipped.test.js":
      "'use strict';\n\ndescribe('later', () => {\n  it.skip('is skipped', () => {});\n  it('is pending without a body');\n});\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 3, run: 1, passed: 1, skipped: 2 }),
  );
  const cases = testCasesOf(s, e.id);
  assert.equal(cases.length, 2, JSON.stringify(cases));
  assert.equal(cases[0]?.outcome, "skipped");
  assert.equal(cases[1]?.outcome, "skipped");
  assert.equal(s.summary.test_cases.skipped, 2);
  assertNothingLeft(r);
});

// A suite that hangs is stopped when the Budget ends. What the reporter wrote
// before that stays in the Report, and the test that never finished is
// never_run.
test("a hanging suite keeps its recorded results when the Budget ends", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, {
    "test/hangs.test.js":
      "'use strict';\n\ndescribe('hangs', function () {\n  this.timeout(0);\n\n  it('never ends', () => new Promise(() => {}));\n});\n",
  });

  // The last 60 seconds of a Budget are kept for the Report, which leaves
  // 20 seconds for the install and the suite.
  const r = await realRun(t, [
    "test",
    original,
    "--only",
    existing,
    "--budget",
    "80s",
  ]);

  assert.equal(r.code, 2, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "budget_exhausted");
  assert.notEqual(e.outcome, "passed");
  assert.deepEqual(
    passedTitles(r, s, e),
    ["add adds two numbers"],
    "the result recorded before the Budget ended is kept",
  );
  const cases = testCasesOf(s, e.id);
  assert.equal(cases.length, 1, JSON.stringify(cases));
  assert.equal(cases[0]?.full_title, "hangs never ends");
  assert.equal(cases[0].outcome, "never_run");
  assert.ok(cases[0].never_run_reason?.includes("stopped"));
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 2, run: 1, passed: 1, never_run: 1 }),
  );
  assertNothingLeft(r);
});

// Mocha 9, 10, 11 and 12 are supported. The same failing suite runs on the
// newest release of each major and has to give the same test cases, so the
// reporter works across the supported versions.
describe("every supported Mocha major gives the same test cases", () => {
  for (const major of ["9", "10", "11", "12"]) {
    test(`mocha ${major}`, async (t) => {
      const original = copyProject(t, "failing-test");
      writeFiles(original, {
        "package.json":
          `{"name":"failing-test","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"^${major}"}}` +
          "\n",
      });
      // No lockfile: npm install resolves the newest release of the major.
      removeFile(original, "package-lock.json");

      const r = await realRun(t, ["test", original, "--only", existing]);

      assert.equal(r.code, 1, r.stderr);
      const s = full(r);
      const e = oneExecution(s, existing);
      assert.equal(e.status, "completed");
      assert.ok(
        e.tool?.version?.startsWith(major + "."),
        JSON.stringify(e.tool),
      );
      const fs = findingsOf(s, existing);
      assert.equal(fs.length, 1, JSON.stringify(fs));
      assert.equal(fs[0]?.expected, "2");
      assert.equal(fs[0].actual, "-2");
      assert.equal(fs[0].locations[0]?.start?.line, 13);
      assert.deepEqual(
        inventoryOf(s, e.context_id),
        counts(e.context_id, { found: 2, run: 2, passed: 1, failed: 1 }),
      );
      assertNothingLeft(r);
    });
  }
});
