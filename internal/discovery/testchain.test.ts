// A test script that chains npm scripts becomes an ordered list of suites.
// The scripts of the package.json are the only input; nothing is run.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveTestScript,
  RunnerMocha,
  RunnerNodeTest,
  type TestRunner,
} from "./discovery.ts";

type WantSuite = [
  origin: string,
  runner: TestRunner,
  args: string[],
  env: Record<string, string>,
];

const scripts = (o: Record<string, string>) => new Map(Object.entries(o));

test("a chain of script references becomes one suite per step", async (t) => {
  const cases: [string, Record<string, string>, WantSuite[]][] = [
    [
      "two references",
      {
        test: "npm run test:unit && npm run test:api",
        "test:unit": "mocha --config test/config/mocha-unit.js",
        "test:api": "mocha --config test/config/mocha-api.js",
      },
      [
        [
          "test:unit",
          RunnerMocha,
          ["--config", "test/config/mocha-unit.js"],
          {},
        ],
        ["test:api", RunnerMocha, ["--config", "test/config/mocha-api.js"], {}],
      ],
    ],
    [
      "run-script and npm options in front of the name",
      {
        test: "npm run-script a && npm --silent run b && npm run --silent c",
        a: "mocha a",
        b: "mocha b",
        c: "node --test c",
      },
      [
        ["a", RunnerMocha, ["a"], {}],
        ["b", RunnerMocha, ["b"], {}],
        ["c", RunnerNodeTest, ["--test", "c"], {}],
      ],
    ],
    [
      "an option with a value in front of the name",
      { test: "npm --loglevel silent run a", a: "mocha a" },
      [["a", RunnerMocha, ["a"], {}]],
    ],
    [
      "nested chain",
      {
        test: "npm run test:all",
        "test:all": "npm run a && npm run b",
        a: "mocha a",
        b: "mocha b",
      },
      [
        ["a", RunnerMocha, ["a"], {}],
        ["b", RunnerMocha, ["b"], {}],
      ],
    ],
    [
      "runner steps written directly, with env and cross-env",
      { test: "NODE_ENV=test mocha unit && cross-env LOG=off c8 mocha api" },
      [
        ["scripts.test#1", RunnerMocha, ["unit"], { NODE_ENV: "test" }],
        ["scripts.test#2", RunnerMocha, ["api"], { LOG: "off" }],
      ],
    ],
    [
      "environment in front of a reference reaches the suite",
      { test: "cross-env NODE_ENV=test npm run a", a: "LOG=off mocha a" },
      [["a", RunnerMocha, ["a"], { NODE_ENV: "test", LOG: "off" }]],
    ],
    [
      "mocha and node:test mixed",
      { test: "npm run a && node --test b", a: "mocha a" },
      [
        ["a", RunnerMocha, ["a"], {}],
        ["scripts.test", RunnerNodeTest, ["--test", "b"], {}],
      ],
    ],
    [
      "arguments after -- go to a single runner command",
      { test: "npm run a -- --grep slow", a: "mocha a" },
      [["a", RunnerMocha, ["a", "--grep", "slow"], {}]],
    ],
    [
      "npm options after the name before -- are ignored",
      { test: "npm run a --silent -- --exit", a: "mocha a" },
      [["a", RunnerMocha, ["a", "--exit"], {}]],
    ],
    [
      "a script used twice is two suites with distinct names",
      { test: "npm run a && npm run a", a: "mocha a" },
      [
        ["a#1", RunnerMocha, ["a"], {}],
        ["a#2", RunnerMocha, ["a"], {}],
      ],
    ],
    [
      "npm test refers to the test script of the package",
      { test: "mocha", ci: "npm test" },
      [["scripts.test", RunnerMocha, [], {}]],
    ],
    [
      "depth five is allowed",
      {
        test: "npm run s1",
        s1: "npm run s2",
        s2: "npm run s3",
        s3: "npm run s4",
        s4: "npm run s5",
        s5: "mocha",
      },
      [["s5", RunnerMocha, [], {}]],
    ],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => {
      const got = resolveTestScript(scripts(input));
      assert.equal(got.unsupported, null);
      assert.equal(got.script, input.test, "the text of scripts.test");
      assert.deepEqual(
        got.suites.map((s) => [
          s.origin,
          s.runner,
          s.args,
          Object.fromEntries(s.env),
        ]),
        want,
      );
    });
  }
});

test("a chain with too many references is refused with the limit", () => {
  // Every level references the next one three times: within the depth
  // limit, but 3^5 suites in total.
  const input: Record<string, string> = {
    test: "npm run s1 && npm run s1 && npm run s1",
    s5: "mocha",
  };
  for (let i = 1; i < 5; i++) {
    const next = `s${String(i + 1)}`;
    input[`s${String(i)}`] =
      `npm run ${next} && npm run ${next} && npm run ${next}`;
  }
  const got = resolveTestScript(scripts(input));
  assert.equal(got.unsupported?.code, "test_command_unsupported");
  assert.ok(got.unsupported.reason.includes("more than 64"));
});

test("a chain drops the wrapper of each step", () => {
  const got = resolveTestScript(
    scripts({ test: "npm run a && npm run b", a: "c8 mocha a", b: "mocha b" }),
  );
  assert.equal(got.unsupported, null);
  assert.deepEqual(
    got.suites.map((s) => s.dropped),
    ["c8", ""],
  );
});

test("a chain leaves out lint steps", () => {
  const got = resolveTestScript(
    scripts({
      test: "npm run lint && eslint . && biome check && mocha",
      lint: "eslint src",
    }),
  );
  assert.equal(got.unsupported, null);
  assert.deepEqual(
    got.suites.map((s) => s.runner),
    [RunnerMocha],
  );
  assert.deepEqual(
    got.leftOut.map((l) => `${l.step} in ${l.script}`),
    ["eslint src in lint", "eslint . in test", "biome check in test"],
  );
});

test("a chain refuses what it cannot run and names the step", async (t) => {
  const cases: [string, Record<string, string>, string, string[]][] = [
    [
      "or-chain",
      { test: "npm run a || npm run b", a: "mocha", b: "mocha" },
      "test_command_unsupported",
      ["||", "`npm run a || npm run b`"],
    ],
    [
      "semicolon",
      { test: "mocha a; mocha b" },
      "test_command_unsupported",
      [";"],
    ],
    [
      "pipe",
      { test: "npm run a | tee x", a: "mocha" },
      "test_command_unsupported",
      ["|"],
    ],
    [
      "single ampersand",
      { test: "mocha a & mocha b" },
      "test_command_unsupported",
      ["&"],
    ],
    [
      "shell syntax in a referenced script",
      { test: "npm run a", a: "mocha || true" },
      "test_command_unsupported",
      ["||", "`a`"],
    ],
    [
      "shell script step",
      { test: "npm run a && ./scripts/it.sh", a: "mocha" },
      "test_command_unsupported",
      ["`./scripts/it.sh`", "test script `npm run a && ./scripts/it.sh`"],
    ],
    [
      "shell script step in a referenced script",
      { test: "npm run all", all: "mocha a && sh run.sh" },
      "test_command_unsupported",
      ["`sh run.sh`", "`all`"],
    ],
    [
      "tsc step",
      { test: "tsc && mocha" },
      "test_command_unsupported",
      ["`tsc`"],
    ],
    [
      "jest step",
      { test: "npm run a && jest", a: "mocha" },
      "test_runner_unsupported",
      ["Jest"],
    ],
    [
      "jest in a referenced script",
      { test: "npm run a", a: "jest --ci" },
      "test_runner_unsupported",
      ["Jest", "`a`"],
    ],
    [
      "missing script",
      { test: "npm run nope && mocha" },
      "test_command_unsupported",
      ["`nope`", "does not exist"],
    ],
    [
      "reference cycle",
      { test: "npm run a", a: "npm run b && mocha", b: "npm run a" },
      "test_command_unsupported",
      ["cycle", "test -> a -> b -> a"],
    ],
    [
      "npm test inside the test script",
      { test: "npm test && mocha" },
      "test_command_unsupported",
      ["cycle"],
    ],
    [
      "too deep",
      {
        test: "npm run s1",
        s1: "npm run s2",
        s2: "npm run s3",
        s3: "npm run s4",
        s4: "npm run s5",
        s5: "npm run s6",
        s6: "mocha",
      },
      "test_command_unsupported",
      ["more than 5 levels", "`s6`"],
    ],
    [
      "pretest",
      {
        test: "npm run a && npm run b",
        a: "mocha",
        b: "mocha",
        pretest: "npm run build",
      },
      "test_command_unsupported",
      ["`pretest`"],
    ],
    [
      "posttest",
      { test: "mocha", posttest: "echo done" },
      "test_command_unsupported",
      ["`posttest`"],
    ],
    [
      "pretest:unit",
      {
        test: "npm run test:unit && npm run test:api",
        "test:unit": "mocha u",
        "test:api": "mocha a",
        "pretest:unit": "x",
      },
      "test_command_unsupported",
      ["`pretest:unit`", "`test:unit`"],
    ],
    [
      "post script",
      {
        test: "npm run unit && npm run api",
        unit: "mocha u",
        api: "mocha a",
        postunit: "x",
      },
      "test_command_unsupported",
      ["`postunit`"],
    ],
    [
      "workspace option",
      { test: "npm run a -w pkg && mocha", a: "mocha" },
      "test_command_unsupported",
      ["-w", "workspace"],
    ],
    [
      "workspace long option",
      { test: "npm run a --workspaces", a: "mocha" },
      "test_command_unsupported",
      ["--workspaces"],
    ],
    [
      "prefix option",
      { test: "npm --prefix sub run a", a: "mocha" },
      "test_command_unsupported",
      ["--prefix"],
    ],
    [
      "arguments on a chain",
      { test: "npm run all -- --exit", all: "mocha a && mocha b" },
      "test_command_unsupported",
      ["arguments after `--`", "`all`"],
    ],
    [
      "only lint steps",
      { test: "eslint . && biome check" },
      "test_command_unsupported",
      ["no test runner step"],
    ],
    [
      "empty step",
      { test: "mocha && " },
      "test_command_unsupported",
      ["empty"],
    ],
    [
      "c8 around an npm step",
      { test: "c8 npm run a", a: "mocha" },
      "test_command_unsupported",
      ["`c8 npm run a`"],
    ],
    [
      "unterminated quote",
      { test: 'npm run a && mocha "x', a: "mocha" },
      "test_command_unsupported",
      ["quote"],
    ],
    [
      "npm run without a name",
      { test: "npm run" },
      "test_command_unsupported",
      ["names no script"],
    ],
    [
      "another npm command",
      { test: "npm ci && mocha" },
      "test_command_unsupported",
      ["`npm ci`"],
    ],
  ];
  for (const [name, input, code, want] of cases) {
    await t.test(name, () => {
      const got = resolveTestScript(scripts(input));
      assert.ok(got.unsupported, "supported");
      assert.deepEqual(got.suites, [], "unsupported tests keep no suites");
      assert.equal(got.unsupported.code, code, got.unsupported.reason);
      for (const w of want) {
        assert.ok(
          got.unsupported.reason.includes(w),
          `${got.unsupported.reason} lacks ${w}`,
        );
      }
    });
  }
});
