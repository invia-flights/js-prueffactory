// The test command is read from scripts.test as words, never run through a
// shell. These cases are the awkward strings real projects have.
import assert from "node:assert/strict";
import { test } from "node:test";

import { quote } from "../resultset/quote.ts";
import {
  parseTestScript,
  RunnerMocha,
  RunnerNodeTest,
  type TestRunner,
} from "./discovery.ts";

test("parseTestScript recognises mocha and node --test", async (t) => {
  const cases: [
    string,
    string,
    TestRunner,
    string[],
    Record<string, string>,
    string,
  ][] = [
    ["plain mocha", "mocha", RunnerMocha, [], {}, ""],
    [
      "quoted paths and a config",
      `mocha 'test/api' "test/unit" --config test/mocha-opts.js`,
      RunnerMocha,
      ["test/api", "test/unit", "--config", "test/mocha-opts.js"],
      {},
      "",
    ],
    [
      "quoted glob stays one word",
      `mocha "test/**/*.test.js" --exit`,
      RunnerMocha,
      ["test/**/*.test.js", "--exit"],
      {},
      "",
    ],
    [
      "leading assignments",
      "NODE_ENV=test TZ=UTC mocha --exit",
      RunnerMocha,
      ["--exit"],
      { NODE_ENV: "test", TZ: "UTC" },
      "",
    ],
    [
      "quoted assignment value",
      `NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" mocha`,
      RunnerMocha,
      [],
      { NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings" },
      "",
    ],
    [
      "cross-env",
      "cross-env NODE_ENV=test LOG_LEVEL=silent mocha test/",
      RunnerMocha,
      ["test/"],
      { NODE_ENV: "test", LOG_LEVEL: "silent" },
      "",
    ],
    [
      "assignments before cross-env",
      "CI=1 cross-env NODE_ENV=test mocha",
      RunnerMocha,
      [],
      { CI: "1", NODE_ENV: "test" },
      "",
    ],
    [
      "c8 is dropped with its options",
      "c8 --reporter=lcov --check-coverage mocha test/",
      RunnerMocha,
      ["test/"],
      {},
      "c8 --reporter=lcov --check-coverage",
    ],
    [
      "nyc with separate option values",
      "nyc --reporter lcov --exclude test mocha --recursive",
      RunnerMocha,
      ["--recursive"],
      {},
      "nyc --reporter lcov --exclude test",
    ],
    [
      "env, cross-env and c8 together",
      "cross-env NODE_ENV=test c8 mocha",
      RunnerMocha,
      [],
      { NODE_ENV: "test" },
      "c8",
    ],
    [
      "mocha from node_modules",
      "./node_modules/.bin/mocha --exit",
      RunnerMocha,
      ["--exit"],
      {},
      "",
    ],
    ["node --test", "node --test", RunnerNodeTest, ["--test"], {}, ""],
    [
      "node --test with a glob",
      `node --test 'test/**/*.test.js'`,
      RunnerNodeTest,
      ["--test", "test/**/*.test.js"],
      {},
      "",
    ],
    [
      "node with flags before --test",
      "NODE_ENV=test node --import ./setup.mjs --test test/",
      RunnerNodeTest,
      ["--import", "./setup.mjs", "--test", "test/"],
      { NODE_ENV: "test" },
      "",
    ],
  ];
  for (const [name, script, runner, args, env, dropped] of cases) {
    await t.test(name, () => {
      const tests = parseTestScript(script);
      assert.equal(tests.unsupported, null);
      assert.equal(tests.suites.length, 1);
      const got = tests.suites[0];
      assert.ok(got);
      assert.equal(got.origin, "scripts.test");
      assert.equal(got.runner, runner);
      assert.deepEqual(got.args, args);
      assert.deepEqual(Object.fromEntries(got.env), env);
      assert.equal(got.dropped, dropped);
      assert.equal(tests.script, script);
    });
  }
});

test("parseTestScript refuses what it cannot run directly", async (t) => {
  const cases: [string, string, string, string[]][] = [
    ["jest", "jest --ci", "test_runner_unsupported", ["Jest", "jest --ci"]],
    ["vitest", "vitest run", "test_runner_unsupported", ["Vitest"]],
    [
      "jest behind cross-env",
      "cross-env NODE_ENV=test jest",
      "test_runner_unsupported",
      ["Jest"],
    ],
    ["jest behind npx", "npx jest", "test_runner_unsupported", ["Jest"]],
    ["ava", "ava", "test_runner_unsupported", ["AVA"]],
    ["tap", "tap", "test_runner_unsupported", ["tap"]],
    ["jasmine", "jasmine", "test_runner_unsupported", ["Jasmine"]],
    ["karma", "karma start", "test_runner_unsupported", ["Karma"]],
    [
      "playwright",
      "playwright test",
      "test_runner_unsupported",
      ["Playwright"],
    ],
    [
      "and-chain",
      "npm run lint && mocha",
      "test_command_unsupported",
      ["npm run lint && mocha", "&&"],
    ],
    ["pipe", "mocha | tee out.log", "test_command_unsupported", ["|"]],
    ["semicolon", "mocha; echo done", "test_command_unsupported", [";"]],
    ["redirect", "mocha > out.txt", "test_command_unsupported", [">"]],
    [
      "command substitution",
      "mocha $(ls test)",
      "test_command_unsupported",
      ["$"],
    ],
    [
      "variable expansion",
      "mocha $TEST_DIR",
      "test_command_unsupported",
      ["$"],
    ],
    [
      "variable in double quotes",
      `mocha "$TEST_DIR"`,
      "test_command_unsupported",
      ["$"],
    ],
    ["backticks", "mocha `ls test`", "test_command_unsupported", ["`"]],
    [
      "script runner",
      "node scripts/run-tests.js",
      "test_command_unsupported",
      ["node scripts/run-tests.js"],
    ],
    [
      "npm run",
      "npm run test:unit",
      "test_command_unsupported",
      ["npm run test:unit"],
    ],
    [
      "unterminated quote",
      `mocha "test`,
      "test_command_unsupported",
      ["quote"],
    ],
    [
      "shell cross-env",
      "cross-env-shell NODE_ENV=test mocha",
      "test_command_unsupported",
      ["cross-env-shell"],
    ],
    [
      "c8 without a runner",
      "c8 npm test",
      "test_command_unsupported",
      ["c8 npm test"],
    ],
    [
      "assignments only",
      "NODE_ENV=test",
      "test_command_unsupported",
      ["NODE_ENV=test"],
    ],
  ];
  for (const [name, script, code, want] of cases) {
    await t.test(name, () => {
      const got = parseTestScript(script);
      assert.ok(got.unsupported, "supported");
      assert.deepEqual(got.suites, [], "unsupported tests keep no suites");
      assert.equal(got.unsupported.code, code, got.unsupported.reason);
      for (const w of want) {
        assert.ok(
          got.unsupported.reason.includes(w),
          `${got.unsupported.reason} lacks ${w}`,
        );
      }
      assert.ok(got.unsupported.reason.includes(script));
      // The script is project text: report.md shows it as a code span.
      assert.ok(got.unsupported.reason.includes(quote(script)));
    });
  }
});
