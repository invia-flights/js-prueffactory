// artifacts.structured on made-up projects (Go: artifacts_structured_test.go).
// The Check is native, so no Docker is involved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import {
  type Applicability,
  type Finding,
  NotApplicable,
  TrustUntrusted,
} from "../resultset/types.ts";
import { parseStructured, yamlParseError } from "./artifacts_structured.ts";
import { Implemented, lookup, PerProject } from "./catalog.ts";
import { impl, projectContext, runCheck, tree } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";

interface StructuredRun {
  applicability: Applicability;
  reason: string;
  result: Result | null;
}

/**
 * runStructured writes the files into a new folder, discovers it and runs
 * the Check in the project Context, the way the engine does.
 */
async function runStructured(
  t: TestContext,
  files: Record<string, string>,
): Promise<StructuredRun> {
  const proj = tree(t, files);
  const c = impl("artifacts.structured");
  const context = projectContext(proj);
  const [applicability, reason] = c.applicability(proj, context);
  if (applicability === NotApplicable) {
    return { applicability, reason, result: null };
  }
  const result = await runCheck(
    "artifacts.structured",
    new Input({
      project: proj,
      context,
      originalPath: proj.root,
      snapshotDir: proj.root,
    }),
  );
  return { applicability, reason, result };
}

function findings(r: StructuredRun): Finding[] {
  return r.result?.findings ?? [];
}

function findingFor(r: StructuredRun, path: string): Finding {
  const f = findings(r).find((x) => x.locations[0]?.path === path);
  assert.ok(f, `no Finding for ${path} in ${JSON.stringify(findings(r))}`);
  return f;
}

function assertNoFindings(r: StructuredRun): void {
  assert.ok(r.result, `the Check was not applicable: ${r.reason}`);
  assert.equal(r.result.status, "completed", r.result.reason);
  assert.deepEqual(
    findings(r).map(
      (f) => `${f.locations[0]?.path ?? ""}: ${f.evidence[0]?.text ?? ""}`,
    ),
    [],
  );
}

function startOf(f: Finding): [number, number | null] | null {
  const s = f.locations[0]?.start;
  return s ? [s.line, s.column] : null;
}

test("the structured Check is implemented for the project Context", () => {
  const e = lookup("artifacts.structured");
  assert.ok(e);
  assert.equal(e.status, Implemented);
  assert.equal(e.scope, PerProject);
  assert.equal(e.canFireGates, true);
  assert.equal(e.area, "validity");
});

test("broken JSON is a Gate with line and column", async (t) => {
  const r = await runStructured(t, {
    "config/app.json": '{\n  "name": "demo",\n  "port": 80,\n}\n',
  });
  assert.equal(r.result?.status, "completed");
  const f = findingFor(r, "config/app.json");
  assert.deepEqual(
    [f.gate, f.severity, f.confidence, f.in_test_data],
    [true, "error", "confirmed", false],
  );
  assert.deepEqual(
    [f.check_id, f.context_id],
    ["artifacts.structured", "C-0001"],
  );
  // The closing brace after the trailing comma.
  assert.deepEqual(startOf(f), [4, 1]);
  assert.notEqual(f.locations[0]?.file_sha256, "");
  assert.equal(f.evidence[0]?.trust, TrustUntrusted);
  assert.ok(f.reproduction.rerun_command.length > 0);
});

const jsoncSample =
  '{\n  // a comment\n  "compilerOptions": { /* inline */ "strict": true },\n  "url": "http://example.com//not-a-comment"\n}\n';

test("valid JSON passes and a project without such files is not applicable", async (t) => {
  assertNoFindings(
    await runStructured(t, {
      "package.json": '{"name":"demo"}',
      "data/bom.json": "\ufeff[1, 2, 3]\n",
    }),
  );
  const r = await runStructured(t, { "index.js": "module.exports = 1;\n" });
  assert.equal(r.applicability, NotApplicable);
  assert.notEqual(r.reason, "");
});

test("comments are accepted only in the files that allow them", async (t) => {
  const allowed = [
    "tsconfig.json",
    "tsconfig.build.json",
    "packages/a/tsconfig.base.json",
    "jsconfig.json",
    ".eslintrc.json",
    "biome.json",
    "biome.jsonc",
    ".devcontainer/devcontainer.json",
    ".vscode/settings.json",
    "app/.vscode/launch.json",
  ];
  assertNoFindings(
    await runStructured(
      t,
      Object.fromEntries(allowed.map((p) => [p, jsoncSample])),
    ),
  );
  for (const p of [
    "package.json",
    "config.json",
    "vscode/settings.json",
    ".vscode/sub/settings.json",
    "mytsconfig.json",
  ]) {
    const f = findingFor(await runStructured(t, { [p]: jsoncSample }), p);
    assert.equal(f.gate, true, p);
    assert.deepEqual(startOf(f), [2, 3], p);
  }
});

test("trailing commas are accepted only where the tools accept them", async (t) => {
  const trailing = '{\n  "a": [1, 2,],\n  "b": 1, // note\n}\n';
  assertNoFindings(
    await runStructured(t, {
      "tsconfig.json": trailing,
      ".vscode/settings.json": trailing,
    }),
  );
  findingFor(await runStructured(t, { "biome.json": trailing }), "biome.json");
});

const gitlabCI = `stages: [test]
.base:
  script:
    - echo base
test:
  script:
    - !reference [.base, script]
    - echo done
  variables:
    SECRET: !vault |
      $ANSIBLE_VAULT;1.1;AES256
`;

test("YAML with several documents and custom tags is accepted", async (t) => {
  assertNoFindings(
    await runStructured(t, {
      ".gitlab-ci.yml": gitlabCI,
      "k8s/all.yaml":
        "apiVersion: v1\nkind: A\n---\napiVersion: v1\nkind: B\n---\n",
      "empty.yaml": "",
      "comments-only.yml": "# nothing here\n",
    }),
  );
});

test("broken YAML is a Gate with its line", async (t) => {
  const r = await runStructured(t, {
    "ci/pipeline.yml": "stages:\n  - test\nbuild:\n  script: @run\n",
    "second.yaml": "a: 1\n---\nb: [\n",
    "tabs.yaml": "a:\n\t- b\n",
  });
  for (const [path, line] of [
    ["ci/pipeline.yml", 4],
    ["second.yaml", 3],
    ["tabs.yaml", 2],
  ] as const) {
    const f = findingFor(r, path);
    assert.deepEqual(
      [f.gate, f.title, f.rule_id],
      [true, "YAML file does not parse", "invalid-yaml"],
      path,
    );
    assert.equal(f.locations[0]?.start?.line, line, path);
  }
});

// A UTF-8 text that was decoded as Windows-1252 once leaves U+009D in a
// description. The parser refuses it without saying where, so the Check
// finds the character itself.
test("YAML with a control character is a Gate at the character", async (t) => {
  const r = await runStructured(t, {
    "api.yml": 'a: 1\nb: x\nnote: "say â€\u009dhi"\n',
  });
  const f = findingFor(r, "api.yml");
  assert.deepEqual([f.gate, f.rule_id], [true, "invalid-yaml"]);
  assert.deepEqual(startOf(f), [3, 14]);
  assert.ok(f.evidence[0]?.text.includes("U+009D"), f.evidence[0]?.text);
});

test("a YAML error without a line is still a Gate at the file", async (t) => {
  const f = findingFor(
    await runStructured(t, { "anchors.yaml": "x: 1\ny: *nope\n" }),
    "anchors.yaml",
  );
  assert.equal(f.gate, true);
  assert.equal(f.locations[0]?.start, null);
  assert.notEqual(f.locations[0].file_sha256, "");
});

test("a broken file in Test data is only a note", async (t) => {
  const r = await runStructured(t, {
    "test/fixtures/broken.json": "{",
    "testdata/bad.yaml": "a:\n\t- b\n",
    "src/broken.json": "{",
  });
  for (const p of ["test/fixtures/broken.json", "testdata/bad.yaml"]) {
    const f = findingFor(r, p);
    assert.deepEqual(
      [f.gate, f.severity, f.in_test_data],
      [false, "note", true],
      p,
    );
  }
  const src = findingFor(r, "src/broken.json");
  assert.deepEqual([src.gate, src.in_test_data], [true, false]);
  assert.equal(findings(r).filter((f) => f.gate).length, 1);
});

test("Build output and Helm templates are skipped and listed", async (t) => {
  const r = await runStructured(t, {
    "dist/bundle.json": "{",
    "packages/ui/build/a.yaml": "a:\n\t- b\n",
    "packages/ui/build/b.json": "{",
    "deploy/chart/Chart.yaml": "name: chart\nversion: 1.0.0\n",
    "deploy/chart/values.yaml": "replicas: 2\n",
    "deploy/chart/templates/d.yaml":
      "kind: Deployment\nspec: {{ .Values.spec }}\n",
    "deploy/chart/templates/c.json": "{{ .Values.x }}",
    "templates/not-a-chart.json": "{",
    "src/ok.json": "{}",
  });
  assert.equal(r.result?.status, "completed");
  // Only the templates/ folder without a Chart.yaml is checked.
  assert.deepEqual(
    findings(r).map((f) => f.locations[0]?.path),
    ["templates/not-a-chart.json"],
  );
  const skipped = new Map<string | null, string>();
  for (const l of r.result.limitations ?? []) {
    skipped.set(l.path, l.reason_code);
    assert.equal(l.check_id, "artifacts.structured");
  }
  assert.deepEqual(
    skipped,
    new Map([
      ["dist", "build_output_skipped"],
      ["packages/ui/build", "build_output_skipped"],
      ["deploy/chart/templates", "helm_templates_skipped"],
    ]),
  );
});

test("a chart at the project root skips its templates too", async (t) => {
  assertNoFindings(
    await runStructured(t, {
      "Chart.yaml": "name: chart\n",
      "templates/svc.yaml": "a: {{ .x }}\n",
      "templates/_cfg.json": "{{ x }}",
    }),
  );
});

test("Findings come sorted by path and keep stable fingerprints", async (t) => {
  const files = { "b/x.json": "{", "a/y.json": "{", "c/z.yaml": "a:\n\t- b\n" };
  const r = await runStructured(t, files);
  const paths = findings(r).map((f) => f.locations[0]?.path ?? "");
  assert.equal(paths.length, 3);
  assert.deepEqual([...paths].sort(compareBytes), paths);
  const again = await runStructured(t, files);
  assert.deepEqual(
    findings(again).map((f) => f.fingerprint),
    findings(r).map((f) => f.fingerprint),
  );
});

test("an unterminated comment and truncated files are Gates at the right place", async (t) => {
  const r = await runStructured(t, {
    "tsconfig.json": '{\n  /* never closed\n  "a": 1\n}\n',
    "cut.json": '{\n  "héllo": "wörld",\n  "x":',
    "wide.json": '{"ключ": }',
    "empty.json": "",
  });
  for (const [p, want] of [
    ["tsconfig.json", [2, 3]],
    ["cut.json", [3, 7]],
    ["wide.json", [1, 10]],
    ["empty.json", [1, 1]],
  ] as const) {
    assert.deepEqual(startOf(findingFor(r, p)), want, p);
  }
});

// No Go counterpart: the parser's error text reaches a pattern, so it must
// not backtrack on long adversarial text.
test("the YAML line pattern stays linear on adversarial input", () => {
  const started = performance.now();
  for (const data of [
    "a: " + "line 1".repeat(200_000) + "\nb: [\n",
    "a: " + "line " + "9".repeat(1_000_000) + "\n\tb: [\n",
    "line " + "1".repeat(500_000) + ": " + " ".repeat(500_000) + "\t\n",
    "x".repeat(2_000_000) + ": [\n",
  ]) {
    const perr = parseStructured("a.yaml", Buffer.from(data));
    assert.ok(perr, data.slice(0, 20));
  }
  assert.ok(performance.now() - started < 10_000);
});

test("the YAML line pattern on an adversarial parser message", () => {
  const started = performance.now();
  const data = Buffer.from("a: 1\n");
  const many = "line 1:".repeat(300_000);
  assert.deepEqual(yamlParseError(data, "yaml: " + many + " end"), {
    rule: "invalid-yaml",
    line: 1,
    column: 0,
    message: "end",
  });
  const digits = "line " + "7".repeat(1_000_000);
  assert.equal(yamlParseError(data, digits).line, 0);
  const spaces = "line 12:" + " \t\r\n\f".repeat(400_000) + "x";
  assert.deepEqual(yamlParseError(data, spaces), {
    rule: "invalid-yaml",
    line: 12,
    column: 0,
    message: "x",
  });
  // RE2's \s has no \v: the vertical tab stays in the message.
  assert.equal(yamlParseError(data, "line 3:\vx").message, "\vx");
  assert.ok(performance.now() - started < 5_000);
});
