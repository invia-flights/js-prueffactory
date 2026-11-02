// Seam A without Docker: list-checks shows the test suites of every package,
// and why a test script that chains scripts is refused.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import type { ListedTests } from "../checks/listing.ts";
import { call } from "./cli.testutil.ts";
import {
  listChecksJSON,
  noDockerEnv,
  testdataProject,
} from "./listchecks.testutil.ts";

async function listedTestsByPath(
  t: TestContext,
  dir: string,
): Promise<Map<string, ListedTests | null>> {
  const l = await listChecksJSON(t, dir, "--format", "json");
  return new Map(l.contexts.map((c) => [c.path, c.tests]));
}

test("list-checks shows the suites of a chain of npm scripts", async (t) => {
  const tests = (
    await listedTestsByPath(t, testdataProject("npm-run-chain"))
  ).get(".");
  assert.ok(tests);
  assert.equal(tests.unsupported, null);
  assert.equal(tests.script, "npm run test:unit && npm run test:api");
  assert.deepEqual(
    tests.suites.map((s) => [s.origin, s.runner, s.args.join(" ")]),
    [
      ["test:unit", "mocha", "--config test/config/mocha-unit.js"],
      ["test:api", "mocha", "--config test/config/mocha-api.js"],
    ],
  );
});

test("list-checks shows the suites in the Markdown table", async (t) => {
  const r = await call(
    noDockerEnv(t),
    "list-checks",
    testdataProject("npm-run-chain"),
  );
  assert.equal(r.code, 0, r.stderr);
  for (const want of [
    "Test suites:",
    "`test:unit`",
    "`test:api`",
    "mocha",
    "--config test/config/mocha-api.js",
  ]) {
    assert.ok(r.stdout.includes(want), `markdown does not hold ${want}`);
  }
});

describe("list-checks names the step and the script of a refused chain", () => {
  const cases: [string, string[]][] = [
    ["packages/or-chain", ["||", "`npm run test:unit || npm run test:api`"]],
    [
      "packages/shell-step",
      [
        "`./scripts/integration.sh`",
        "`npm run test:unit && ./scripts/integration.sh`",
      ],
    ],
    ["packages/lifecycle", ["`pretest:unit`", "`test:unit`"]],
    ["packages/cycle", ["cycle", "test -> test:all -> test:again -> test:all"]],
  ];
  for (const [path, wants] of cases) {
    test(path, async (t) => {
      const byPath = await listedTestsByPath(
        t,
        testdataProject("npm-run-chain-unsupported"),
      );
      const tests = byPath.get(path);
      assert.ok(tests?.unsupported);
      assert.equal(tests.unsupported.code, "test_command_unsupported");
      assert.deepEqual(tests.suites, []);
      for (const w of wants) {
        assert.ok(tests.unsupported.reason.includes(w), w);
      }
      // The root package has no tests.
      assert.equal(byPath.get(".") ?? null, null);
    });
  }
});

// The Markdown of list-checks shows project text that a reason quotes, such
// as a chain step, as a code span, as report.md does: `&&` stays `&&` and the
// backticks are not escaped.
test("list-checks Markdown shows quoted text of a reason as a code span", async (t) => {
  const r = await call(
    noDockerEnv(t),
    "list-checks",
    testdataProject("npm-run-chain-unsupported"),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes("&amp;") && !r.stdout.includes("\\`"));
  assert.ok(
    r.stdout.includes("`npm run test:unit && ./scripts/integration.sh`"),
  );
});
