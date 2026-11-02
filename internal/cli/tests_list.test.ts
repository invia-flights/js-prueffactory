// Seam A without Docker: what list-checks says about tests.existing and
// tests.coverage for the scripts.test strings real projects have, and for
// every reason a package's tests cannot be run (Go: tests_existing_test.go,
// tests_coverage_test.go).
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import { listChecksJSON, projectWith, rowOf } from "./listchecks.testutil.ts";

const lock = '{"lockfileVersion":3,"packages":{}}';

async function only(
  t: TestContext,
  id: string,
  files: Record<string, string>,
): Promise<[string, string]> {
  const l = await listChecksJSON(t, projectWith(t, files), "--format", "json");
  const a = rowOf(l, id).applicability;
  assert.equal(a.length, 1);
  return [a[0]?.applicability ?? "", a[0]?.reason ?? ""];
}

test("tests.existing is implemented and can fire Gates", async (t) => {
  const l = await listChecksJSON(
    t,
    projectWith(t, { "package.json": '{"name":"demo"}' }),
    "--format",
    "json",
  );
  const row = rowOf(l, "tests.existing");
  assert.equal(row.status, "implemented");
  assert.ok(row.selected && row.can_fire_gates);
  assert.equal(row.benchmark_area, "tests");
});

describe("list-checks accepts the test scripts it can run", () => {
  const scripts: [string, string][] = [
    ["plain", "mocha"],
    [
      "quoted paths",
      "mocha 'test/api' 'test/unit' --config test/mocha-opts.js",
    ],
    ["env assignment", "NODE_ENV=test mocha --exit"],
    ["cross-env", "cross-env NODE_ENV=test mocha"],
    ["c8 wrapper", "c8 --reporter=lcov mocha test/"],
    ["nyc wrapper", "nyc mocha"],
    ["c8 behind cross-env", "cross-env NODE_ENV=test c8 mocha"],
  ];
  for (const [name, script] of scripts) {
    test(name, async (t) => {
      // The Mocha version, known only after the install, decides how the run
      // goes, so list-checks does not guess.
      const [got, reason] = await only(t, "tests.existing", {
        "package.json": `{"name":"demo","scripts":{"test":${JSON.stringify(script)}}}`,
        "package-lock.json": lock,
      });
      assert.equal(got, "unknown");
      assert.ok(reason.includes("Mocha version"), reason);
    });
  }
});

describe("list-checks names why the tests cannot be run", () => {
  const cases: [string, Record<string, string>, string[]][] = [
    [
      "jest",
      {
        "package.json": '{"scripts":{"test":"jest --ci"}}',
        "package-lock.json": lock,
      },
      ["Jest", "jest --ci"],
    ],
    [
      "vitest",
      {
        "package.json": '{"scripts":{"test":"vitest run"}}',
        "package-lock.json": lock,
      },
      ["Vitest", "vitest run"],
    ],
    [
      "ava",
      {
        "package.json": '{"scripts":{"test":"ava"}}',
        "package-lock.json": lock,
      },
      ["AVA"],
    ],
    [
      "chained commands",
      {
        "package.json": '{"scripts":{"test":"npm run lint && mocha"}}',
        "package-lock.json": lock,
      },
      ["npm run lint && mocha", "&&"],
    ],
    [
      "a script file",
      {
        "package.json": '{"scripts":{"test":"node scripts/test.js"}}',
        "package-lock.json": lock,
      },
      ["node scripts/test.js"],
    ],
    [
      "variable expansion",
      {
        "package.json": '{"scripts":{"test":"mocha $SPECS"}}',
        "package-lock.json": lock,
      },
      ["mocha $SPECS", "$"],
    ],
    [
      "another package manager",
      {
        "package.json": '{"scripts":{"test":"mocha"}}',
        "yarn.lock": "# yarn\n",
      },
      ["yarn.lock"],
    ],
    [
      "npm workspaces",
      {
        "package.json": '{"workspaces":["p/*"],"scripts":{"test":"mocha"}}',
        "package-lock.json": lock,
      },
      ["workspaces"],
    ],
  ];
  for (const [name, files, wants] of cases) {
    test(name, async (t) => {
      const [got, reason] = await only(t, "tests.existing", files);
      assert.equal(got, "applicable");
      assert.ok(reason.startsWith("unsupported: "), reason);
      for (const w of wants) {
        assert.ok(reason.includes(w), `${reason} lacks ${w}`);
      }
    });
  }
});

test("list-checks finds Mocha through its config file without a test script", async (t) => {
  const [got, reason] = await only(t, "tests.existing", {
    "package.json": '{"name":"demo"}',
    ".mocharc.json": '{"spec":["test/*.js"]}',
    "package-lock.json": lock,
  });
  assert.equal(got, "unknown");
  assert.ok(reason.includes("Mocha version"), reason);
});

describe("list-checks says not_applicable when there is nothing to run", () => {
  const cases: [string, string][] = [
    ["no test script", '{"name":"demo","scripts":{"start":"node ."}}'],
    [
      "npm's placeholder",
      '{"name":"demo","scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}',
    ],
  ];
  for (const [name, manifest] of cases) {
    test(name, async (t) => {
      const [got, reason] = await only(t, "tests.existing", {
        "package.json": manifest,
      });
      assert.equal(got, "not_applicable");
      assert.ok(reason.includes("no test script"), reason);
    });
  }
});

test("tests.coverage is implemented, selected and never fires Gates", async (t) => {
  const l = await listChecksJSON(
    t,
    projectWith(t, { "package.json": '{"name":"demo"}' }),
    "--format",
    "json",
  );
  const row = rowOf(l, "tests.coverage");
  assert.equal(row.status, "implemented");
  assert.equal(row.selected, true);
  assert.equal(row.can_fire_gates, false);
  assert.equal(row.benchmark_area, "side_indicator");
});

test("tests.coverage applies to a package with tests that can run", async (t) => {
  const [got, reason] = await only(t, "tests.coverage", {
    "package.json": '{"name":"demo","scripts":{"test":"c8 mocha"}}',
    "package-lock.json": lock,
  });
  assert.equal(got, "unknown");
  assert.ok(reason.includes("Mocha version"), reason);
});

test("tests.coverage is unsupported where the runner is and not_applicable without tests", async (t) => {
  let [got, reason] = await only(t, "tests.coverage", {
    "package.json": '{"scripts":{"test":"jest --ci"}}',
    "package-lock.json": lock,
  });
  assert.equal(got, "applicable");
  assert.ok(
    reason.startsWith("unsupported: ") && reason.includes("Jest"),
    reason,
  );
  [got, reason] = await only(t, "tests.coverage", {
    "package.json": '{"name":"demo","scripts":{"start":"node ."}}',
  });
  assert.equal(got, "not_applicable");
  assert.ok(reason.includes("no test script"), reason);
});
