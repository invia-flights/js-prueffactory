// What tests.smells, deps.engines and lint.correctness ask of the combined
// ESLint run (their rule groups) and what they make of its output (Go:
// eslint_groups_test.go). The run itself needs Docker and is covered by
// cli/eslint_groups.docker.test.ts. The quality.metrics tests of the Go file
// belong to ticket 22.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ConfidenceConfirmed,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import "./all.ts";
import { Implemented, lookup, PerPackage } from "./catalog.ts";
import { interpretDepsEngines } from "./deps_engines.ts";
import {
  fileResult,
  limitationText,
  packageInput,
  run,
  eslintProblems,
} from "./eslint.testutil.ts";
import { eslintGroups } from "./eslint_exec.ts";
import { groupSpec } from "./eslint_run.ts";
import { interpretLintCorrectness } from "./lint_correctness.ts";
import { interpretTestsSmells } from "./tests_smells.ts";

test("the checks are implemented per package and only tests.smells can fire Gates", () => {
  for (const [id, gates] of [
    ["tests.smells", true],
    ["deps.engines", false],
  ] as const) {
    const entry = lookup(id);
    assert.equal(entry?.status, Implemented, id);
    assert.equal(entry.scope, PerPackage, id);
    assert.equal(entry.canFireGates, gates, id);
  }
});

function spec(
  id: string,
  mutate?: (input: ReturnType<typeof packageInput>) => void,
) {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  mutate?.(input);
  const g = eslintGroups.get(id);
  assert.ok(g, `${id} has no rule group`);
  return groupSpec(g, input);
}

test("the test smells group holds the thirteen Mocha rules on Test code with test as a test-case name", () => {
  const s = spec("tests.smells");

  assert.deepEqual(
    s.rules.map((r) => r.name),
    [
      "mocha/handle-done-callback",
      "mocha/no-async-and-done",
      "mocha/no-async-in-sync-tests",
      "mocha/no-async-suite",
      "mocha/no-code-after-done",
      "mocha/no-conditional-tests",
      "mocha/no-done-twice",
      "mocha/no-empty-title",
      "mocha/no-exclusive-tests",
      "mocha/no-identical-title",
      "mocha/no-nested-tests",
      "mocha/no-pending-tests",
      "mocha/no-return-and-done",
    ],
    "the spec's list in name order",
  );
  assert.equal(s.testOnly, true);
  assert.deepEqual(s.plugins, ["mocha"]);
  assert.equal(s.coreProblem, false);
  const names = marshalAny(s.settings);
  assert.ok(names.includes('"name":"test"'), names);
  assert.ok(names.includes('"type":"testCase"'), names);
});

test("the engines group holds the four plugin n rules with the Context's Node version", () => {
  const s = spec("deps.engines", (input) => {
    assert.ok(input.context.node);
    input.context.node.version = "22.11.0";
  });

  assert.deepEqual(
    s.rules.map((r) => r.name),
    [
      "n/no-deprecated-api",
      "n/no-unsupported-features/es-builtins",
      "n/no-unsupported-features/es-syntax",
      "n/no-unsupported-features/node-builtins",
    ],
  );
  assert.equal(s.testOnly, false);
  assert.deepEqual(s.plugins, ["n"]);
  assert.equal(marshalAny(s.settings), '{"n":{"version":"22.11.0"}}');
});

test("a Node version that is not plain numbers is never given to the plugin", () => {
  // A bare major is the Context's Node major: the plugin is given the exact
  // version of the pinned image of that major, such as 24.22.1 for Node 24.
  const cases: [string, string][] = [
    ["24", "24.22.1"],
    ["22", "22.23.4"],
    ["22.11", "22.11"],
    ["22.11.0", "22.11.0"],
    [">=18 || <x", "24.22.1"],
    ["", "24.22.1"],
    ["v22", "24.22.1"],
    ["99", "99"],
    ["9223372036854775808", "9223372036854775808"],
  ];
  for (const [version, want] of cases) {
    const s = spec("deps.engines", (input) => {
      assert.ok(input.context.node);
      input.context.node.version = version;
    });
    assert.equal(
      marshalAny(s.settings),
      `{"n":{"version":"${want}"}}`,
      `version ${JSON.stringify(version)}`,
    );
  }
});

test("the Alpine variant gets the same exact version without the suffix", () => {
  const s = spec("deps.engines", (input) => {
    assert.ok(input.context.node);
    input.context.node.version = "26";
    input.context.node.variant = "alpine";
  });
  assert.equal(marshalAny(s.settings), '{"n":{"version":"26.12.1"}}');
});

test("unused vars ignores names that start with an underscore", () => {
  const s = spec("lint.correctness");

  assert.equal(
    marshalAny(s.coreOptions.get("no-unused-vars")),
    '[{"argsIgnorePattern":"^_","caughtErrorsIgnorePattern":"^_","destructuredArrayIgnorePattern":"^_","varsIgnorePattern":"^_"}]',
  );
  assert.equal(s.coreOptions.size, 1, "only no-unused-vars");
});

function smellsRun() {
  return run(
    {
      version: "10.13.0",
      groups: new Map([
        [
          "tests.smells",
          ["mocha/no-exclusive-tests", "mocha/no-pending-tests"],
        ],
        ["lint.correctness", ["no-self-assign"]],
      ]),
      config: new Map([["eslint", "10.13.0"]]),
      results: [
        fileResult("test/index.test.js", [
          {
            rule_id: "mocha/no-pending-tests",
            message: "Unexpected pending mocha test.",
            line: 8,
            column: 3,
          },
          {
            rule_id: "mocha/no-exclusive-tests",
            message: "Unexpected exclusive mocha test.",
            line: 6,
            column: 1,
          },
          {
            rule_id: "no-self-assign",
            message: "another group's hit",
            line: 1,
            column: 1,
          },
        ]),
      ],
    },
    { configSHA256: "abc123" },
  );
}

test("a committed .only is a Gate and other smells are warnings", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);

  const res = interpretTestsSmells(input, smellsRun());

  assert.equal(res.status, StatusCompleted, res.reason);
  const findings = res.findings ?? [];
  assert.equal(
    findings.length,
    2,
    "the two smells and none of another group's rules",
  );
  for (const f of findings) {
    switch (f.rule_id) {
      case "mocha/no-exclusive-tests":
        assert.ok(
          f.gate &&
            f.severity === SeverityError &&
            f.confidence === ConfidenceConfirmed,
          "a Gate",
        );
        break;
      case "mocha/no-pending-tests":
        assert.ok(!f.gate && f.severity === SeverityWarning, "a warning");
        break;
      default:
        assert.fail(`unexpected rule ${String(f.rule_id)}`);
    }
    assert.equal(f.check_id, "tests.smells");
    assert.equal(f.locations[0]?.path, "test/index.test.js");
  }
  assert.equal(res.tool?.name, "eslint");
  assert.ok((res.contextTools ?? []).length > 0);
});

test("engines findings are warnings in any file", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = run({
    version: "10.13.0",
    groups: new Map([["deps.engines", ["n/no-deprecated-api"]]]),
    results: [
      fileResult("src/index.js", [
        {
          rule_id: "n/no-deprecated-api",
          message: "'new Buffer()' was deprecated since v6.0.0.",
          line: 4,
          column: 10,
        },
      ]),
    ],
  });

  const res = interpretDepsEngines(input, r);

  const [f] = res.findings ?? [];
  assert.equal(res.findings?.length, 1);
  assert.ok(f);
  assert.ok(
    !f.gate &&
      f.severity === SeverityWarning &&
      f.check_id === "deps.engines" &&
      f.rule_id === "n/no-deprecated-api",
    "a warning of deps.engines with the native rule ID",
  );
});

// A file that ESLint could not parse has no hits because nobody looked, so a
// Check that reads the run is partial when a file of its scope was not parsed.
// What counts as the scope: every linted file for lint.correctness and
// deps.engines, Test code for tests.smells.

const unparsedResult = (path: string) =>
  fileResult(path, [
    {
      fatal: true,
      message: "Parsing error: Unexpected token",
      line: 1,
      column: 1,
    },
  ]);

describe("every Check of the run that covers an unparsed file is partial with the count in its reason", () => {
  const interpreters = {
    "lint.correctness": interpretLintCorrectness,
    "deps.engines": interpretDepsEngines,
    "tests.smells": interpretTestsSmells,
  };
  for (const [id, interpret] of Object.entries(interpreters)) {
    test(id, () => {
      const { proj, dir } = eslintProblems();
      const input = packageInput(proj, dir);
      // src/a.js is Source code, test/index.test.js is Test code.
      const r = run({
        groups: new Map([[id, []]]),
        results: [
          unparsedResult("test/index.test.js"),
          unparsedResult("src/a.js"),
        ],
      });
      const want = id === "tests.smells" ? 1 : 2; // src/a.js is not Test code

      const res = interpret(input, r);

      assert.equal(res.status, StatusPartial);
      assert.equal(res.reasonCode, "files_not_parsed");
      assert.ok(
        res.reason?.includes(`ESLint could not parse ${String(want)} file`),
        res.reason,
      );
      const limit = res.limitations?.find(
        (l) => l.reason_code === "files_not_parsed",
      );
      assert.ok(
        limit?.message.includes("test/index.test.js"),
        limitationText(res),
      );
    });
  }
});

test("test smells stay completed when only Source code did not parse", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = run({
    groups: new Map([["tests.smells", []]]),
    results: [unparsedResult("src/a.js")],
  });

  const res = interpretTestsSmells(input, r);

  assert.equal(
    res.status,
    StatusCompleted,
    "the Check looks at Test code only, and that parsed",
  );
});

test("oversized and unparsed files both show in the partial reason", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = run(
    {
      groups: new Map([["lint.correctness", []]]),
      results: [unparsedResult("src/a.js")],
    },
    { oversized: ["src/big.js"] },
  );

  const res = interpretLintCorrectness(input, r);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "files_not_parsed");
  assert.ok(res.reason?.includes("1 file"), res.reason);
  assert.ok(res.reason?.includes("files"), res.reason);
});
