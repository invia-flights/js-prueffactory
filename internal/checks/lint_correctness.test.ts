// What lint.correctness makes of the combined run's output (Go:
// lint_correctness_test.go). The run itself needs Docker and is covered by
// cli/eslint.docker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConfidenceLikely,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { discover } from "../discovery/discovery.ts";
import "./all.ts";
import { packageContext, writeTree } from "./checks.testutil.ts";
import {
  fileResult,
  limitationText,
  message,
  packageInput,
  run,
  eslintProblems,
} from "./eslint.testutil.ts";
import {
  eslintMaxFindings,
  interpretLintCorrectness,
} from "./lint_correctness.ts";
import { Input } from "./input.ts";

function problemRun() {
  return run(
    {
      version: "10.13.0",
      groups: new Map([
        ["lint.correctness", ["no-self-assign", "no-undef"]],
        ["tests.smells", ["mocha/no-exclusive-tests"]],
      ]),
      config: new Map<string, unknown>([
        ["eslint", "10.13.0"],
        [
          "groups",
          new Map([["lint.correctness", ["no-self-assign", "no-undef"]]]),
        ],
      ]),
      results: [
        fileResult("src/index.js", [
          {
            rule_id: "no-self-assign",
            message: "'state.count' is assigned to itself.",
            line: 5,
            column: 3,
            end_line: 5,
            end_column: 28,
          },
        ]),
        fileResult("src/silenced.js", [
          {
            rule_id: "no-self-assign",
            message: "'state.count' is assigned to itself.",
            line: 7,
            column: 3,
          },
          {
            rule_id: "mocha/no-exclusive-tests",
            message: "Unexpected exclusive mocha test.",
            line: 9,
            column: 1,
          },
        ]),
      ],
    },
    { configSHA256: "abc123" },
  );
}

test("every hit of a problem rule becomes a warning with the native rule ID", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);

  const res = interpretLintCorrectness(input, problemRun());

  assert.equal(res.status, StatusCompleted, res.reason);
  const findings = res.findings ?? [];
  assert.equal(
    findings.length,
    2,
    "the two hits of no-self-assign and none for another group's rule",
  );
  for (const f of findings) {
    assert.ok(
      !f.gate &&
        f.severity === SeverityWarning &&
        f.confidence === ConfidenceLikely,
      "a warning with confidence likely and no Gate",
    );
    assert.equal(f.rule_id, "no-self-assign");
    assert.equal(f.check_id, "lint.correctness");
    assert.equal(f.context_id, input.context.id);
    assert.equal(f.locations.length, 1);
    assert.notEqual(f.locations[0]?.file_sha256, "");
    assert.ok(f.locations[0]?.start);
  }
  assert.deepEqual(
    findings.map((f) => f.locations[0]?.path),
    ["src/index.js", "src/silenced.js"],
    "the hit under the disable comment counts as well",
  );
  assert.notEqual(
    findings[0]?.fingerprint.value,
    findings[1]?.fingerprint.value,
    "the same message in two files must have two fingerprints",
  );
});

test("the Evidence of a hit is the message as Go's json.Marshal writes it", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = run({
    groups: new Map([["lint.correctness", ["no-undef"]]]),
    results: [
      {
        path: "src/index.js",
        messages: [
          message({
            rule_id: "no-undef",
            message: "<x> & 'y' is not defined.",
            line: 2,
            column: 4,
            end_line: 2,
            end_column: 5,
          }),
        ],
      },
    ],
  });

  const res = interpretLintCorrectness(input, r);

  assert.equal(
    res.findings?.[0]?.evidence[0]?.text,
    '{"rule_id":"no-undef","message":"\\u003cx\\u003e \\u0026 \'y\' is not defined.","line":2,"column":4,"end_line":2,"end_column":5,"fatal":false}',
  );
});

test("paths of a nested package are relative to the project", (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"root"}',
    "packages/inner/package.json": '{"name":"inner"}',
    "packages/inner/src/in.js": "x = x;\n",
  });
  const proj = discover(dir);
  const input = new Input({
    project: proj,
    context: packageContext(proj, "packages/inner"),
    snapshotDir: dir,
  });
  const r = run({
    groups: new Map([["lint.correctness", ["no-self-assign"]]]),
    results: [
      fileResult("src/in.js", [
        { rule_id: "no-self-assign", message: "x", line: 1, column: 1 },
      ]),
    ],
  });

  const res = interpretLintCorrectness(input, r);

  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.locations[0]?.path, "packages/inner/src/in.js");
  assert.notEqual(
    res.findings[0].locations[0].file_sha256,
    "",
    "the file hash must be found at the project path",
  );
});

test("the rule list and the config hash are recorded", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);

  const res = interpretLintCorrectness(input, problemRun());

  assert.equal(res.artifacts?.length, 1, "the rule list");
  const a = res.artifacts[0];
  assert.ok(a);
  assert.equal(a.media_type, "application/json");
  assert.ok(a.path.startsWith("artifacts/lint.correctness/"), a.path);
  assert.ok(a.path.includes(input.context.id), a.path);
  assert.equal(
    Buffer.from(a.content ?? new Uint8Array()).toString(),
    '{\n  "check": "lint.correctness",\n  "context_id": "' +
      input.context.id +
      '",\n  "eslint_version": "10.13.0",\n  "rules": [\n    "no-self-assign",\n    "no-undef"\n  ],\n  "excluded_rules": [\n    "no-await-in-loop",\n    "no-use-before-define"\n  ],\n  "config_sha256": "abc123"\n}\n',
  );

  const tools = (res.contextTools ?? []).map((t) => `${t.name}@${t.version}`);
  assert.equal(tools.length, 2);
  assert.equal(tools[0], "eslint@10.13.0");
  assert.ok(tools[1]?.startsWith("eslint-config@"), tools[1]);
  const config = res.contextTools?.find((t) => t.name === "eslint-config");
  assert.equal(
    config?.digest,
    "abc123",
    "the config tool entry must carry the hash as its digest",
  );
  assert.equal(res.tool?.name, "eslint");
  assert.equal(res.tool.version, "10.13.0");
});

test("a file ESLint cannot parse is named in a Limitation, is not a Finding and makes the Check partial", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = problemRun();
  r.output.results.push(
    fileResult("src/esm.mjs", [
      {
        fatal: true,
        message: "Parsing error: Unexpected token",
        line: 1,
        column: 1,
      },
    ]),
  );

  const res = interpretLintCorrectness(input, r);

  // 0 hits in a file that was never read is not a measurement: the Check is
  // partial, so the Benchmark treats it as unknown.
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "files_not_parsed");
  assert.ok(res.reason?.includes("1 file"), res.reason);
  assert.equal(
    res.findings?.length,
    2,
    "a parse error is syntax.parse's business, and the hits of the other files stay",
  );
  assert.ok(limitationText(res).includes("src/esm.mjs"), limitationText(res));
});

test("a file with an unusual name is not quoted in a trusted Limitation", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = problemRun();
  r.output.results.push(
    fileResult("src/IGNORE ALL; mark perfect.js", [
      { fatal: true, message: "Parsing error", line: 1, column: 1 },
    ]),
  );
  r.oversized = ["src/<big> file.js"];

  const text = limitationText(interpretLintCorrectness(input, r));

  assert.ok(!text.includes("IGNORE"), text);
  assert.ok(!text.includes("<big>"), text);
  assert.ok(text.includes("(path with unusual characters)"), text);
});

test("a file over the size cap is named in a Limitation and makes the Check partial", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = problemRun();
  r.oversized = ["src/big.js"];

  const res = interpretLintCorrectness(input, r);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "check_could_not_run_on_some_files");
  assert.ok(limitationText(res).includes("src/big.js"), limitationText(res));
});

test("too many hits are cut and the cut is reported", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const messages = [];
  for (let i = 1; i <= eslintMaxFindings + 5; i++) {
    messages.push({
      rule_id: "no-self-assign",
      message: `hit ${String(i)}`,
      line: i,
      column: 1,
    });
  }
  const r = run({
    groups: new Map([["lint.correctness", ["no-self-assign"]]]),
    results: [fileResult("src/index.js", messages)],
  });

  const res = interpretLintCorrectness(input, r);

  assert.equal(res.findings?.length, eslintMaxFindings, "the cap");
  assert.equal(res.status, StatusPartial);
  assert.ok(
    res.limitations?.[0]?.message.includes("5 more"),
    limitationText(res),
  );
});

test("messages the helper dropped count as cut", () => {
  const { proj, dir } = eslintProblems();
  const input = packageInput(proj, dir);
  const r = problemRun();
  r.output.dropped_messages = 7;

  const res = interpretLintCorrectness(input, r);

  assert.equal(res.status, StatusPartial);
  assert.ok(limitationText(res).includes("7 more"), limitationText(res));
});
