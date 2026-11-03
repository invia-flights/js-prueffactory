// What lint.existing makes of the output of Biome 2.x (spec "Trustworthy
// gates", ticket 06). The recorded files in testdata/biome/ are what Biome
// 2.1.2 and 2.6.4 printed for the same sources (project-biome-current): the
// JSON reporter of 2.1 writes a location whose path is an object and a byte
// span, the one of 2.4 and later a plain path and start and end positions.
// Biome's own configuration diagnostics are the only text that blames the
// project's configuration; output that cannot be read is a tool problem.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  type Finding,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { biomeFindings } from "./lint_existing_parse.ts";
import {
  cr,
  isVersionQuery,
  lint,
  lintTree,
  ok,
  withFakeLinters,
} from "./lint_existing.testutil.ts";
import { maxRawOutputBytes } from "./tool_output.ts";

const recorded = (name: string): Buffer =>
  readFileSync(join(import.meta.dirname, "testdata", "biome", name));

const biomeFiles = {
  "package.json": '{"devDependencies":{"@biomejs/biome":"2.6.4"}}',
  "biome.json": "{}\n",
  "src/index.js": "1;\n",
  "test/index.test.js": "1;\n",
};

/** where is what a user reads of a Finding: its rule, place, severity and Gate. */
const where = (f: Finding): (string | number | boolean | null)[] => [
  f.rule_id,
  f.locations[0]?.path ?? null,
  f.locations[0]?.start?.line ?? null,
  f.locations[0]?.start?.column ?? null,
  f.severity,
  f.gate,
];

// Both versions found the same three things in the same sources: a warning
// and an error in Source code and the same error in Test code. The positions
// are the ones of a reader of the files.
const sameThreeFindings = [
  ["lint/suspicious/noConsole", "src/index.js", 3, 3, "warning", false],
  ["lint/suspicious/noDebugger", "src/index.js", 2, 3, "error", true],
  ["lint/suspicious/noDebugger", "test/index.test.js", 4, 3, "error", false],
];

for (const [version, file] of [
  ["2.1.2", "2.1.2-report.json"],
  ["2.6.4", "2.6.4-report.json"],
]) {
  test(`the JSON report of Biome ${version ?? ""} gives the Findings at their line and column`, (t) => {
    const input = lintTree(t, biomeFiles);

    const findings = biomeFindings(input, recorded(file ?? ""));

    assert.deepEqual(findings.map(where), sameThreeFindings);
  });
}

test("the deprecation notice that Biome 2.6 prints about biome.json is a note without a Gate and no configuration error", (t) => {
  const input = lintTree(t, biomeFiles);

  const findings = biomeFindings(
    input,
    recorded("2.6.4-report-deprecated-key.json"),
  );

  assert.deepEqual(
    findings.map(where).filter((w) => w[1] === "biome.json"),
    [["deserialize", "biome.json", 4, 13, "note", false]],
  );
  assert.deepEqual(
    findings.filter((f) => f.rule_id === "biome-config-error"),
    [],
  );
});

test("a configuration diagnostic of the error level in the JSON report is the Gate biome-config-error", (t) => {
  const input = lintTree(t, biomeFiles);
  // The shape of Biome 2.6; Biome 2.1 to 2.6 stop before they print a report
  // when the configuration is wrong, so this is built from the documented
  // category and not recorded.
  const report = JSON.stringify({
    summary: {},
    diagnostics: [
      {
        severity: "error",
        message:
          "enabled has an incorrect type, expected a boolean, but received a string.",
        category: "deserialize",
        location: {
          path: "biome.json",
          start: { line: 3, column: 23 },
          end: { line: 3, column: 35 },
        },
        advices: [],
      },
      {
        severity: "warning",
        message: "Don't use console.",
        category: "lint/suspicious/noConsole",
        location: {
          path: "src/index.js",
          start: { line: 3, column: 3 },
          end: { line: 3, column: 14 },
        },
        advices: [],
      },
    ],
    command: "lint",
  });

  const findings = biomeFindings(input, Buffer.from(report));

  assert.deepEqual(
    findings.map((f) => [f.rule_id, f.gate, f.severity, f.locations[0]?.path]),
    [
      ["biome-config-error", true, "error", "biome.json"],
      ["lint/suspicious/noConsole", false, "warning", "src/index.js"],
    ],
  );
  assert.ok(
    findings[0]?.evidence[0]?.text.includes("incorrect type"),
    "Biome's own diagnostic is the Evidence",
  );
});

// --- the run ---

/** biomeRun answers the version query and the lint run of a stood-in Biome. */
function biomeRun(
  t: Parameters<typeof lintTree>[0],
  answer: ReturnType<typeof cr>,
) {
  const input = lintTree(t, biomeFiles);
  const fake = withFakeLinters(t, (cmd) =>
    isVersionQuery(cmd) ? ok("2.6.4\n") : answer,
  );
  return { input, fake };
}

const rawPath = (contextID: string, call: string, stream: string): string =>
  `artifacts/lint.existing/${contextID}/${call}.${stream}.txt`;

const rawOf = (
  arts: { path: string; content?: Uint8Array | null }[] | undefined,
  path: string,
): string | undefined => {
  const a = (arts ?? []).find((x) => x.path === path);
  return a?.content == null ? undefined : Buffer.from(a.content).toString();
};

const recordedReport = recorded("2.6.4-report.json").toString();
const deprecationOnStderr = recorded(
  "2.6.4-stderr-deprecated-key.txt",
).toString();
const rejectedConfiguration = recorded(
  "2.6.4-stderr-rejected-configuration.txt",
).toString();

const unreadable: Record<
  string,
  { exitCode: number; stdout: string; stderr: string }
> = {
  "no output at all with exit code 0": { exitCode: 0, stdout: "", stderr: "" },
  "no output at all with exit code 1": {
    exitCode: 1,
    stdout: "",
    stderr: "Biome did not say why\n",
  },
  "plain text instead of a report": {
    exitCode: 0,
    stdout: "Biome has nothing to say about this project\n",
    stderr: "",
  },
  "a JSON document of another shape": {
    exitCode: 1,
    stdout: '{"results":[{"file":"src/index.js","problems":[]}]}',
    stderr: "",
  },
  "diagnostics without a severity": {
    exitCode: 1,
    stdout: '{"diagnostics":[{"category":"lint/x","message":"m"}]}',
    stderr: "",
  },
  "a category of another type": {
    exitCode: 1,
    stdout: '{"diagnostics":[{"category":5,"severity":"error"}]}',
    stderr: "",
  },
  "a location in a shape that neither Biome 2.1 nor 2.6 writes": {
    exitCode: 1,
    stdout:
      '{"diagnostics":[{"severity":"error","category":"lint/x","message":"m","location":{"path":{"file":"a.js"},"span":{"start":1,"end":2}}}]}',
    stderr: "",
  },
  "a truncated report": {
    exitCode: 1,
    stdout: recordedReport.slice(0, 300),
    stderr: "",
  },
  "an unreadable report next to a deprecation notice": {
    // A reading problem must not be taken for a configuration error because
    // the same Biome also printed a diagnostic about biome.json.
    exitCode: 1,
    stdout: '{"summary":{},"issues":[]}',
    stderr: deprecationOnStderr,
  },
  "an unreadable report next to a rejected configuration": {
    // Biome that printed a report got as far as linting.
    exitCode: 1,
    stdout: '{"summary":{},"issues":[]}',
    stderr: rejectedConfiguration,
  },
  "a rejected configuration at exit code 0": {
    exitCode: 0,
    stdout: "",
    stderr: rejectedConfiguration,
  },
  "a deprecation notice and nothing else": {
    exitCode: 1,
    stdout: "",
    stderr: deprecationOnStderr,
  },
};

for (const [what, answer] of Object.entries(unreadable)) {
  test(`Biome output that cannot be read is a tool problem with the raw output kept: ${what}`, async (t) => {
    const { input } = biomeRun(
      t,
      cr({
        exitCode: answer.exitCode,
        stdout: Buffer.from(answer.stdout),
        stderr: Buffer.from(answer.stderr),
      }),
    );

    const res = await lint(input);

    assert.deepEqual(
      [res.status, res.reasonCode],
      [StatusToolError, "tool_output_unreadable"],
      res.reason ?? "",
    );
    assert.deepEqual(res.findings ?? [], [], "no Finding about the project");
    const id = input.context.id;
    assert.equal(
      rawOf(res.artifacts, rawPath(id, "lint-biome", "stdout")),
      answer.stdout,
    );
    assert.equal(
      rawOf(res.artifacts, rawPath(id, "lint-biome", "stderr")),
      answer.stderr,
    );
    for (const a of res.artifacts ?? []) {
      if (a.path.endsWith(".stdout.txt") || a.path.endsWith(".stderr.txt")) {
        assert.equal(a.maxBytes, maxRawOutputBytes, a.path);
      }
    }
    assert.ok(
      (res.reason ?? "").includes(rawPath(id, "lint-biome", "stdout")),
      `the reason names the artifact: ${res.reason ?? ""}`,
    );
  });
}

const configDiagnostics: Record<string, [file: string, message: string]> = {
  "a value of the wrong type": [
    "2.6.4-stderr-rejected-configuration.txt",
    "enabled has an incorrect type, expected a boolean, but received a string.",
  ],
  "an unknown key": [
    "2.6.4-stderr-unknown-key.txt",
    "Found an unknown key `bogusKey`.",
  ],
  "a syntax error in biome.json": [
    "2.6.4-stderr-broken-syntax.txt",
    "Expected a property but instead found '}'.",
  ],
  "an extended file that is missing": [
    "2.6.4-stderr-missing-extends.txt",
    "No such file or directory (os error 2)",
  ],
};

for (const [what, [file, message]] of Object.entries(configDiagnostics)) {
  test(`Biome's own diagnostic about its configuration is a Gate with that diagnostic as Evidence: ${what}`, async (t) => {
    const stderr = recorded(file).toString();
    const { input } = biomeRun(
      t,
      cr({ exitCode: 1, stderr: Buffer.from(stderr) }),
    );

    const res = await lint(input);

    assert.equal(res.status, StatusCompleted);
    assert.equal(res.findings?.length, 1);
    const f = res.findings[0];
    assert.ok(f);
    assert.deepEqual(
      [f.rule_id, f.gate, f.severity, f.locations[0]?.path],
      ["biome-config-error", true, "error", "biome.json"],
    );
    assert.ok(f.message.endsWith(message), f.message);
    const evidence = f.evidence[0];
    assert.ok(evidence);
    assert.ok(evidence.text.startsWith(stderr.slice(0, 40)));
    assert.ok(evidence.text.includes(message), evidence.text);
    assert.equal(evidence.trust, "untrusted_data");
    assert.equal(res.artifacts?.length, 1, "only the record of the linters");
  });
}

test("Biome that prints a deprecation notice next to a readable report is not blamed for its configuration", async (t) => {
  const { input } = biomeRun(
    t,
    cr({
      exitCode: 1,
      stdout: recorded("2.6.4-report-deprecated-key.json"),
      stderr: Buffer.from(deprecationOnStderr),
    }),
  );

  const res = await lint(input);

  assert.equal(res.status, StatusCompleted);
  assert.deepEqual(
    (res.findings ?? []).filter((f) => f.rule_id === "biome-config-error"),
    [],
  );
  assert.equal(res.findings?.filter((f) => f.gate).length, 1);
});

test("an unreadable report after the retry without VCS keeps the raw output of the retry", async (t) => {
  const input = lintTree(t, biomeFiles);
  const noIgnoreFile = recorded("2.6.4-stderr-missing-ignore-file.txt");
  const fake = withFakeLinters(t, (cmd) => {
    if (isVersionQuery(cmd)) {
      return ok("2.6.4\n");
    }
    if (cmd.includes("--vcs-enabled=false")) {
      return cr({
        stdout: Buffer.from("not a report"),
        stderr: Buffer.from("retry stderr"),
      });
    }
    return cr({ exitCode: 1, stderr: noIgnoreFile });
  });

  const res = await lint(input);

  assert.equal(fake.count("biome lint"), 2, "the run and one retry");
  assert.deepEqual(
    [res.status, res.reasonCode, res.findings ?? []],
    [StatusToolError, "tool_output_unreadable", []],
  );
  const id = input.context.id;
  assert.equal(
    rawOf(res.artifacts, rawPath(id, "lint-biome-novcs", "stdout")),
    "not a report",
  );
  assert.equal(
    rawOf(res.artifacts, rawPath(id, "lint-biome", "stdout")),
    undefined,
    "the first run was no unreadable output: Biome said why it could not start",
  );
});

test("Biome's real message about a missing ignore file still leads to the retry without VCS", async (t) => {
  const input = lintTree(t, biomeFiles);
  const fake = withFakeLinters(t, (cmd) => {
    if (isVersionQuery(cmd)) {
      return ok("2.6.4\n");
    }
    if (cmd.includes("--vcs-enabled=false")) {
      return cr({ exitCode: 1, stdout: recorded("2.6.4-report.json") });
    }
    return cr({
      exitCode: 1,
      stderr: recorded("2.6.4-stderr-missing-ignore-file.txt"),
    });
  });

  const res = await lint(input);

  assert.equal(fake.count("biome lint"), 2);
  assert.equal(res.status, StatusCompleted);
  assert.deepEqual((res.findings ?? []).map(where), sameThreeFindings);
  assert.equal(res.limitations?.[0]?.reason_code, "biome_vcs_disabled");
});

test("when ESLint could be read and Biome could not, the result is partial and keeps the ESLint Findings", async (t) => {
  const input = lintTree(t, {
    "package.json":
      '{"devDependencies":{"eslint":"^9","@biomejs/biome":"2.6.4"}}',
    "eslint.config.js": "export default [];\n",
  });
  withFakeLinters(t, (cmd) => {
    if (isVersionQuery(cmd)) {
      return ok("9.39.0\n");
    }
    if (cmd.join(" ").includes("eslint.js")) {
      return cr({
        exitCode: 1,
        stdout: Buffer.from(
          '[{"filePath":"/work/a.js","messages":[{"ruleId":"no-undef","severity":2,"message":"m","line":1,"column":1}]}]',
        ),
      });
    }
    return cr({ stdout: Buffer.from("plain text") });
  });

  const res = await lint(input);

  assert.deepEqual(
    [res.status, res.reasonCode],
    [StatusPartial, "tool_output_unreadable"],
  );
  assert.deepEqual(
    (res.findings ?? []).map((f) => f.evidence[0]?.origin),
    ["eslint"],
  );
});

test("ESLint output that cannot be read is a tool problem with the raw output kept", async (t) => {
  const input = lintTree(t, {
    "package.json": '{"devDependencies":{"eslint":"^9"}}',
    "eslint.config.js": "export default [];\n",
  });
  withFakeLinters(t, (cmd) =>
    isVersionQuery(cmd)
      ? ok("9.39.0\n")
      : cr({
          exitCode: 1,
          stdout: Buffer.from("Oops! Something went wrong!"),
          stderr: Buffer.from("tail"),
        }),
  );

  const res = await lint(input);

  assert.deepEqual(
    [res.status, res.reasonCode, res.findings ?? []],
    [StatusToolError, "tool_output_unreadable", []],
  );
  const id = input.context.id;
  assert.equal(
    rawOf(res.artifacts, rawPath(id, "lint-eslint", "stdout")),
    "Oops! Something went wrong!",
  );
  assert.equal(
    rawOf(res.artifacts, rawPath(id, "lint-eslint", "stderr")),
    "tail",
  );
});
