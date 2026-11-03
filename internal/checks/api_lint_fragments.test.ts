// api.lint lints a description file without `paths` as a fragment, without
// Docker: the containers are stood in, so the tests see what Redocly is given
// and what the Report shows.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContainerSpec } from "../docker/driver.ts";
import type { Answer } from "./unreadable_output.testutil.ts";
import { run } from "./unreadable_output.testutil.ts";

const template =
  "openapi: 3.0.3\ninfo:\n  title: Template\n  version: '1'\npaths:\nx-after: 1\n";
const legacy = 'swagger: "2.0"\ninfo:\n  title: Legacy\n  version: "1"\n';
const complete =
  "openapi: 3.0.3\ninfo:\n  title: Complete\n  version: '1'\npaths: {}\n";
const modern = "openapi: 3.1.0\ninfo:\n  title: Modern\n  version: '1'\n";

/** problem is one Redocly problem at a line of the file it was given. */
function problem(rule: string, line: number): string {
  return `{"ruleId":"${rule}","severity":"warn","message":"${rule} here","location":[{"start":{"line":${String(line)},"col":3}}]}`;
}

function report(...problems: string[]): string {
  return `{"totals":{"errors":0,"warnings":0,"ignored":0},"version":"2.70.0","problems":[${problems.join(",")}]}`;
}

/** lintOf is the file name a Redocly container was asked to lint. */
function lintOf(spec: ContainerSpec): string | undefined {
  const cmd = spec.cmd ?? [];
  return cmd[0] === "lint" ? cmd[cmd.length - 1] : undefined;
}

function textOf(spec: ContainerSpec, path: string): string | undefined {
  const f = (spec.files ?? []).find((x) => x.path === path);
  return f === undefined ? undefined : Buffer.from(f.content).toString();
}

test("a file that is not valid YAML is not linted, and the Limitation does not claim a Gate that artifacts.structured does not have for a file in Documentation", async (t) => {
  const specs: ContainerSpec[] = [];
  const res = await run(
    t,
    "api.lint",
    { "docs/openapi.yaml": "openapi: 3.0.3\ninfo: [\n  title: x\n" },
    (spec) => {
      specs.push(spec);
      return {};
    },
  );
  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.equal(
    specs.filter((s) => lintOf(s) !== undefined).length,
    0,
    "the broken file is not linted",
  );
  const l = (res.limitations ?? []).find(
    (x) => x.reason_code === "file_not_parseable",
  );
  assert.ok(l, JSON.stringify(res.limitations));
  assert.equal(l.path, "docs/openapi.yaml");
  assert.ok(l.message.includes("artifacts.structured"), l.message);
  assert.ok(!/gate/i.test(l.message), l.message);
});

test("a file without paths is linted as a copy with an empty paths map and the Limitation openapi_fragment names it", async (t) => {
  const specs: ContainerSpec[] = [];
  const res = await run(
    t,
    "api.lint",
    {
      "api/template.yaml": template,
      "api/legacy.yaml": legacy,
      "api/complete.yaml": complete,
      "api/modern.yaml": modern,
    },
    (spec) => {
      specs.push(spec);
      const file = lintOf(spec);
      if (file === undefined) {
        return {};
      }
      return {
        stdout: report(problem("rule-in-" + file.replace(".yaml", ""), 4)),
      };
    },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  const lints = specs.filter((s) => lintOf(s) !== undefined);
  assert.equal(lints.length, 4);

  // Redocly is given the copy of the two fragments, in a copy of the Snapshot
  // where the relative references of the file still resolve; the other two
  // run on the Snapshot itself.
  const byFile = new Map(lints.map((s) => [lintOf(s), s]));
  const mounts = (s: ContainerSpec | undefined) =>
    (s?.mounts ?? []).map((m) => [m.volume, m.readOnly === true]);
  for (const name of ["template.yaml", "legacy.yaml"]) {
    const s = byFile.get(name);
    assert.equal(s?.workDir, "/fragments/api", name);
    assert.notDeepEqual(mounts(s), [["jspf-run-snapshot", true]], name);
  }
  const specOf = (name: string): ContainerSpec => {
    const s = byFile.get(name);
    assert.ok(s, name);
    return s;
  };
  assert.equal(
    textOf(specOf("template.yaml"), "/fragments/api/template.yaml"),
    template.replace("paths:\n", "paths: {}\n"),
  );
  assert.equal(
    textOf(specOf("legacy.yaml"), "/fragments/api/legacy.yaml"),
    legacy + "paths: {}\n",
  );
  for (const name of ["complete.yaml", "modern.yaml"]) {
    const s = byFile.get(name);
    assert.equal(s?.workDir, "/snapshot/api", name);
    assert.deepEqual(mounts(s), [["jspf-run-snapshot", true]], name);
  }

  // The copy of the Snapshot is made once, with nothing but a copy command.
  const copies = specs.filter((s) => lintOf(s) === undefined);
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0]?.cmd, ["-a", "/snapshot/.", "/fragments/"]);

  // The Findings carry the original path and the line Redocly names.
  const found = (res.findings ?? [])
    .map((f) => [f.rule_id, f.locations[0]?.path, f.locations[0]?.start?.line])
    .sort();
  assert.deepEqual(found, [
    ["rule-in-complete", "api/complete.yaml", 4],
    ["rule-in-legacy", "api/legacy.yaml", 4],
    ["rule-in-modern", "api/modern.yaml", 4],
    ["rule-in-template", "api/template.yaml", 4],
  ]);

  const limitations = (res.limitations ?? [])
    .filter((l) => l.reason_code === "openapi_fragment")
    .map((l) => [l.path, l.check_id])
    .sort();
  assert.deepEqual(limitations, [
    ["api/legacy.yaml", "api.lint"],
    ["api/template.yaml", "api.lint"],
  ]);
  for (const l of res.limitations ?? []) {
    assert.match(l.message, /paths/);
    assert.match(l.message, /not checked/);
  }
});

test("without a fragment no copy of the Snapshot is made and there is no Limitation", async (t) => {
  const specs: ContainerSpec[] = [];
  const res = await run(
    t,
    "api.lint",
    { "complete.yaml": complete, "modern.yaml": modern },
    (spec) => {
      specs.push(spec);
      return { stdout: report() };
    },
  );

  assert.deepEqual([res.status, res.reasonCode ?? ""], ["completed", ""]);
  assert.deepEqual(res.limitations ?? [], []);
  assert.equal(specs.length, 2);
  for (const s of specs) {
    assert.equal(s.workDir, "/snapshot");
  }
});

test("a copy that cannot be made leaves the fragment unlinted and says so", async (t) => {
  const answer = (spec: ContainerSpec): Answer =>
    lintOf(spec) === undefined
      ? { exitCode: 1, stderr: "cp: no space left on device" }
      : { stdout: report() };
  const res = await run(
    t,
    "api.lint",
    { "template.yaml": template, "complete.yaml": complete },
    answer,
  );

  assert.deepEqual(res.findings ?? [], []);
  assert.equal(res.status, "partial");
  assert.equal(res.reasonCode, "check_could_not_run_on_some_files");
  assert.match(res.reason ?? "", /no space left on device/);
  assert.deepEqual(
    (res.limitations ?? []).filter((l) => l.reason_code === "openapi_fragment"),
    [],
  );
});
