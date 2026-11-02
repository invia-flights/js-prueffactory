// Seam A with a real Docker daemon, for the toolset volume and quality.clones
// (Go: cli_clones_docker_test.go). The Go tests run the default Selection
// without tests.existing; until every Check is ported these select
// quality.clones, which is what they assert on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { contextTools } from "./graph.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  findingsOf,
  full,
  oneExecution,
  writeFiles,
} from "./suites.testutil.ts";

const clones = "quality.clones";

void test("quality-signals reports the deliberate clone as a note and the source duplication as a metric", async (t) => {
  const original = copyProject(t, "quality-signals");

  const r = await realRun(t, ["test", original, "--only", clones]);

  assert.equal(
    r.code,
    0,
    `clones are notes and never Gates\nstderr:\n${r.stderr}`,
  );
  const s = full(r);
  const exec = oneExecution(s, clones);
  assert.equal(exec.status, "completed", exec.reason ?? "");
  assert.equal(exec.context_id, "C-0001", "the project Context");
  assert.notEqual(exec.outcome, "failed", "a clone must never fail the Check");
  assert.equal(exec.tool?.version, "5.4.2");

  // One clone, between the two Source code files. The copies in test/fixtures
  // (Test data) and dist (Build output) are never scanned.
  const found = findingsOf(s, clones);
  assert.equal(found.length, 1, JSON.stringify(found));
  const f = found[0];
  assert.ok(f);
  assert.equal(f.gate, false);
  assert.equal(f.severity, "note");
  assert.deepEqual(
    f.locations.map((l) => l.path),
    ["src/invoice.js", "src/order.js"],
  );
  assert.equal(s.summary.gates, 0);

  // The metric: jscpd counts 13 duplicated lines (src/invoice.js 3-15 and its
  // copy) among the 116 lines jscpd counts in the six Source code files, so
  // 13/116 = 11.21 percent. Files in test/fixtures and dist would change that.
  const metrics = new Map(
    s.metrics.filter((m) => m.check_id === clones).map((m) => [m.name, m]),
  );
  const src = metrics.get("duplication_percent_source");
  assert.ok(
    src?.value !== null &&
      src !== undefined &&
      src.value >= 11.2 &&
      src.value <= 11.22,
    `source duplication = ${String(src?.value)}, want 11.21 percent`,
  );
  assert.equal(
    metrics.get("duplication_percent_test")?.value,
    0,
    "the only test file has no clone",
  );

  // The project Context records the tool, and the Report the toolset version.
  const tools = (contextTools(r)[0]?.tools ?? []).map(
    (tool) => `${tool.name}@${tool.version}`,
  );
  assert.ok(tools.includes("jscpd@5.4.2"), tools.join(","));
  assert.notEqual(
    (s as unknown as { profiles: { toolset_version: string } }).profiles
      .toolset_version,
    "",
    "the Report records the toolset version",
  );
  assertNothingLeft(r);
});

// The title of a clone does not name the File class, so report.md says "in
// Test code" once: through the hint the in_test_code flag adds.
void test("a clone in Test code says in Test code once and a Source clone not at all", async (t) => {
  const original = copyProject(t, "quality-signals");
  const invoice = readFileSync(join(original, "src", "invoice.js"), "utf8");
  writeFiles(original, {
    "test/copy-a.test.js": invoice,
    "test/copy-b.test.js": invoice,
  });

  const r = await realRun(t, ["test", original, "--only", clones]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const byRule = new Map(
    findingsOf(s, clones).map((f) => [f.rule_id ?? "", f]),
  );
  const source = byRule.get("clone.source");
  const test = byRule.get("clone.test");
  assert.ok(
    source && test,
    `one clone.source and one clone.test: ${[...byRule.keys()].join(",")}`,
  );
  assert.equal(test.title, "Duplicated code");
  assert.equal(test.in_test_code, true);
  assert.equal(source.title, "Duplicated code");
  assert.equal(source.in_test_code, false);

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  const lineOf = (id: string): string =>
    md.split("\n").find((l) => l.startsWith(`- ${id} [`)) ?? "";
  assert.ok(
    lineOf(test.id).endsWith(": Duplicated code (in Test code)"),
    lineOf(test.id),
  );
  assert.ok(lineOf(source.id).endsWith(": Duplicated code"), lineOf(source.id));
  assert.equal(
    md.split("in Test code").length - 1,
    1,
    `report.md says "in Test code" once:\n${md}`,
  );
  assertNothingLeft(r);
});

void test("file names that look like options are scanned as files, never passed as options", async (t) => {
  const original = copyProject(t, "quality-signals");
  // The names come from the project, which is untrusted. jscpd has options
  // such as -x and --exit-code, and a file called like one must not act as one.
  const files: Record<string, string> = {};
  for (const name of ["-x.js", "--exit-code.js"]) {
    files[`src/${name}`] =
      `'use strict';\n\nmodule.exports = { name: '${name}' };\n`;
  }
  writeFiles(original, files);

  const r = await realRun(t, ["test", original, "--only", clones]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, clones);
  assert.equal(e.status, "completed", e.reason ?? "");
  assert.equal(findingsOf(s, clones).length, 1, "the one deliberate clone");
});

void test("a second Run reuses the toolset volume and leaves it behind", async (t) => {
  const original = copyProject(t, "quality-signals");

  const first = await realRun(t, ["test", original, "--only", clones]);
  const second = await realRun(t, ["test", original, "--only", clones]);

  for (const [i, r] of [first, second].entries()) {
    assert.equal(r.code, 0, `run ${String(i + 1)}\n${r.stderr}`);
    assertNothingLeft(r);
  }
  // Whether the first Run installed depends on the host: an earlier Run of
  // the same build may have filled the volume. The second Run never installs.
  assert.ok(
    !second.stderr.includes("installing toolset") &&
      second.stderr.includes("reusing toolset volume"),
    `the second Run should reuse the volume without installing:\n${second.stderr}`,
  );
  const version = (r: typeof first): string =>
    (full(r) as unknown as { profiles: { toolset_version: string } }).profiles
      .toolset_version;
  assert.equal(
    version(first),
    version(second),
    "the toolset version differs between two Runs of one binary",
  );
  // That the volume outlives a Run is tested with Ensure, under a toolset
  // version of its own: here another Run of a different build on the same
  // Docker host may legitimately remove an unused volume of this version.
});
