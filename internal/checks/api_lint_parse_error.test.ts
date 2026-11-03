// api.lint with a file Redocly cannot read (spec "Trustworthy gates", ticket
// 09). When Redocly prints its documented "Failed to parse API description"
// message for a file that the native parser of artifacts.structured accepts,
// the two readers disagree, and that is a warning about the file, not a tool
// problem. Redocly runs as a stood-in container that answers with the text
// the pinned Redocly 2.70.0 printed in Docker.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type {
  ContainerResult,
  ContainerSpec,
  Driver,
} from "../docker/driver.ts";
import { TrustUntrusted } from "../resultset/types.ts";
import { catalog } from "./catalog.ts";
import { projectContext, runCheck, tree } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { resolve } from "./selection.ts";

interface Answer {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

async function lint(
  t: TestContext,
  files: Record<string, string>,
  answer: Answer | ((spec: ContainerSpec) => Answer),
  only: string[] = ["api.lint", "artifacts.structured"],
): Promise<Result> {
  const proj = tree(t, files);
  const docker = {
    runContainer: (_signal: AbortSignal, spec: ContainerSpec) => {
      const a = typeof answer === "function" ? answer(spec) : answer;
      return Promise.resolve({
        exitCode: a.exitCode ?? 0,
        oomKilled: false,
        stdout: Buffer.from(a.stdout ?? ""),
        stderr: Buffer.from(a.stderr ?? ""),
        stoppedAfterGrace: false,
      } satisfies ContainerResult);
    },
  } as unknown as Driver;
  return runCheck(
    "api.lint",
    new Input({
      project: proj,
      context: projectContext(proj),
      originalPath: proj.root,
      snapshotDir: proj.root,
      snapshotVolume: "jspf-run-snapshot",
      network: "jspf-run-net",
      toolsetVolume: "jspf-toolset",
      docker,
      selection: resolve(catalog(), only, []),
    }),
  );
}

// A double-quoted description whose second line starts in column 0. The
// native YAML parser accepts it; Redocly's parser reports a deficient
// indentation at 6:1.
const yamlIndentation =
  'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\n  description: "first line\nsecond line at column zero"\npaths: {}\n';
const redoclyIndentation =
  'validating openapi.yaml...\nFailed to parse API description at openapi.yaml:\n\n  - deficient indentation in "/snapshot/openapi.yaml" (6:1)\n';

test("a file Redocly cannot read but the native parser accepts is one warning at Redocly's position", async (t) => {
  const res = await lint(
    t,
    { "openapi.yaml": yamlIndentation },
    { exitCode: 1, stderr: redoclyIndentation },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(res.artifacts ?? [], []);
  assert.deepEqual(res.limitations ?? [], []);
  const findings = res.findings ?? [];
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.ok(f);
  assert.deepEqual(
    [f.rule_id, f.severity, f.confidence, f.gate],
    ["redocly-parse-error", "warning", "likely", false],
  );
  const where = f.locations[0];
  assert.deepEqual(
    [where?.path, where?.start?.line, where?.start?.column],
    ["openapi.yaml", 6, 1],
  );
  assert.ok(
    f.message.includes("YAML parser accepts the file") &&
      f.message.includes("YAML readers disagree"),
    f.message,
  );
  // Redocly's own words are Evidence and nothing the Report says by itself.
  assert.ok(
    !f.message.includes("deficient indentation") &&
      !f.title.includes("deficient indentation"),
  );
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0]?.trust, TrustUntrusted);
  const said = f.evidence.map((e) => e.text).join("\n");
  assert.ok(
    said.includes('deficient indentation in "/snapshot/openapi.yaml" (6:1)'),
    said,
  );
});

test("a JSON file with a duplicated key says that the JSON parser accepts it", async (t) => {
  const res = await lint(
    t,
    {
      "api.json":
        '{\n  "openapi": "3.0.3",\n  "info": { "title": "Orders", "version": "1.0.0", "title": "Again" },\n  "paths": {}\n}\n',
    },
    {
      exitCode: 1,
      stderr:
        'validating api.json...\nFailed to parse API description at api.json:\n\n  - duplicated mapping key in "/snapshot/api.json" (3:53)\n',
    },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.equal((res.findings ?? []).length, 1);
  const f = (res.findings ?? [])[0];
  assert.ok(f);
  assert.deepEqual(
    [f.rule_id, f.locations[0]?.start?.line, f.locations[0]?.start?.column],
    ["redocly-parse-error", 3, 53],
  );
  assert.ok(f.message.includes("JSON parser accepts the file"), f.message);
  assert.ok(!f.message.includes("YAML parser"), f.message);
});

test("a message without a position is still a warning on the file", async (t) => {
  const res = await lint(
    t,
    { "openapi.yaml": yamlIndentation },
    {
      exitCode: 1,
      stderr: "Failed to parse API description at openapi.yaml:\n\n  - bad\n",
    },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.equal((res.findings ?? []).length, 1);
  const f = (res.findings ?? [])[0];
  assert.ok(f);
  // A file with no known position has no start.
  assert.deepEqual(
    [f.rule_id, f.locations[0]?.path, f.locations[0]?.start],
    ["redocly-parse-error", "openapi.yaml", null],
  );
});

test("the warning does not depend on artifacts.structured being in the Run", async (t) => {
  const res = await lint(
    t,
    { "openapi.yaml": yamlIndentation },
    { exitCode: 1, stderr: redoclyIndentation },
    ["api.lint"],
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(
    (res.findings ?? []).map((f) => [f.rule_id, f.severity]),
    [["redocly-parse-error", "warning"]],
  );
});

test("a file Redocly cannot read leaves the report of another file alone", async (t) => {
  const res = await lint(
    t,
    { "a.yaml": yamlIndentation, "b.yaml": yamlIndentation },
    (spec) =>
      (spec.cmd ?? []).includes("b.yaml")
        ? {
            exitCode: 1,
            stderr:
              'Failed to parse API description at b.yaml:\n\n  - deficient indentation in "/snapshot/b.yaml" (6:1)\n',
          }
        : {
            stdout:
              '{"totals":{"errors":0,"warnings":0,"ignored":0},"version":"2.70.0","problems":[]}',
          },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(
    (res.findings ?? []).map((f) => [f.rule_id, f.locations[0]?.path]),
    [["redocly-parse-error", "b.yaml"]],
  );
});

// Both readers reject: today's behaviour stays.
const yamlControlCharacter =
  'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1.0.0"\n  description: "broken \u0001 here"\npaths: {}\n';
const redoclyControlCharacter =
  'validating openapi.yaml...\nFailed to parse API description at openapi.yaml:\n\n  - expected valid JSON character in "/snapshot/openapi.yaml" (5:24)\n';

test("a file that both readers reject keeps its Limitation when artifacts.structured is in the Run", async (t) => {
  const res = await lint(
    t,
    { "openapi.yaml": yamlControlCharacter },
    { exitCode: 1, stderr: redoclyControlCharacter },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(res.findings ?? [], []);
  assert.deepEqual(
    (res.limitations ?? []).map((l) => [l.reason_code, l.path]),
    [["file_not_parseable", "openapi.yaml"]],
  );
});

test("a file that both readers reject is an error without a Gate when artifacts.structured is not in the Run", async (t) => {
  const res = await lint(
    t,
    { "openapi.yaml": yamlControlCharacter },
    { exitCode: 1, stderr: redoclyControlCharacter },
    ["api.lint"],
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(
    (res.findings ?? []).map((f) => [f.rule_id, f.severity, f.gate]),
    [["unparseable", "error", false]],
  );
});

// Anything else is not the documented message.
const unrecognized: Record<string, Answer> = {
  "another Redocly message": {
    exitCode: 1,
    stderr:
      "validating openapi.yaml...\nSomething went wrong when processing openapi.yaml:\n\n  - Document must be JSON object, got undefined\n",
  },
  "the message of another step": {
    exitCode: 1,
    stderr:
      "Failed to resolve API description at openapi.yaml:\n\n  - cannot read it\n",
  },
  "plain text": { exitCode: 1, stdout: "something else entirely" },
  "no output at all": { exitCode: 1 },
};

for (const [what, answer] of Object.entries(unrecognized)) {
  test(`${what} for a file the native parser accepts stays a tool problem with the raw output kept`, async (t) => {
    const res = await lint(t, { "openapi.yaml": yamlIndentation }, answer);

    assert.deepEqual(
      [res.status, res.reasonCode],
      ["tool_error", "tool_output_unreadable"],
    );
    assert.deepEqual(res.findings ?? [], []);
    const kept = new Map(
      (res.artifacts ?? []).map((a) => [
        a.path,
        Buffer.from(a.content ?? "").toString(),
      ]),
    );
    assert.deepEqual([...kept].sort(), [
      ["artifacts/api.lint/C-0001/redocly-1.stderr.txt", answer.stderr ?? ""],
      ["artifacts/api.lint/C-0001/redocly-1.stdout.txt", answer.stdout ?? ""],
    ]);
  });
}
