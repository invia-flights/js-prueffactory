// Seam A with a real Docker daemon, for schema.compile (Go:
// schema_compile_docker_test.go). The Go tests run the default Selection;
// these select schema.compile, whose Findings and status they read.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  byPath,
  executionIn,
  findingsIn,
  gatesIn,
  parseReport,
} from "./parse.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("a broken local ref in a draft-04 schema is a Gate and valid schemas compile", async (t) => {
  const original = copyProject(t, "repository-files");

  const r = await realRun(t, ["test", original, "--only", "schema.compile"]);

  const s = parseReport(r);
  const e = executionIn(s, "schema.compile");
  assert.deepEqual(
    [e.status, e.outcome, e.context_id, e.gate],
    ["completed", "failed", "C-0001", 1],
    r.stderr,
  );
  assert.ok(e.tool?.version, JSON.stringify(e.tool));

  // Only the draft-04 schema with the broken local $ref.
  const gates = gatesIn(s, "schema.compile");
  assert.deepEqual([...gates.keys()], ["schemas/legacy.schema.json"]);
  const f = gates.get("schemas/legacy.schema.json");
  assert.equal(f?.rule_id, "unresolved-ref");
  assert.ok(f.message.includes("draft-04"), f.message);
  for (const g of findingsIn(s, "schema.compile")) {
    const p = g.locations[0]?.path ?? "";
    assert.ok(
      !p.startsWith("schemas/order") && !p.startsWith("schemas/item"),
      `a valid schema has a finding: ${p}`,
    );
  }

  // The project Context records the three tools with their integrity.
  const tools = new Map((s.contexts[0]?.tools ?? []).map((x) => [x.name, x]));
  for (const name of ["ajv", "ajv-draft-04", "ajv-formats"]) {
    const tr = tools.get(name);
    assert.ok(tr?.version, name);
    assert.notEqual(tr.digest, null, name);
  }
  assertNothingLeft(r);
});

test("schemas resolve relative references, remote ones are not fetched and Test data only gets notes", async (t) => {
  const original = copyProject(t, "repository-files");
  const files: Record<string, string> = {
    // A relative reference between schemas without an id, in a folder with
    // glob characters, and a YAML schema.
    "api [v1] {draft}*/a.schema.json":
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"b":{"$ref":"b.schema.yaml"}}}',
    "api [v1] {draft}*/b.schema.yaml":
      "$schema: https://json-schema.org/draft/2020-12/schema\ntype: integer\n",
    // A reference to another host: never fetched, so a Limitation and no Finding.
    "schemas/remote.schema.json":
      '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"x":{"$ref":"http://schemas.invalid/x.json"}}}',
    // Only strict mode objects to the unknown keyword: a warning.
    "schemas/loose.schema.json":
      '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","x-internal":true,"frobnicate":1}',
    // Test data is only ever a note.
    "test/fixtures/bad.schema.json":
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"nonsense"}',
    // File names that look like options.
    "schemas/-x.schema.json":
      '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}',
  };
  for (const [name, content] of Object.entries(files)) {
    const p = join(original, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  const r = await realRun(t, ["test", original, "--only", "schema.compile"]);

  const s = parseReport(r);
  const e = executionIn(s, "schema.compile");
  // Partial for the remote reference.
  assert.equal(e.status, "partial", e.reason ?? r.stderr);
  const found = byPath(findingsIn(s, "schema.compile"));
  for (const p of found.keys()) {
    assert.ok(
      !p.startsWith("api [v1]") &&
        p !== "schemas/remote.schema.json" &&
        p !== "schemas/-x.schema.json",
      `unexpected finding for ${p}`,
    );
  }
  const loose = found.get("schemas/loose.schema.json");
  assert.deepEqual(
    [loose?.gate, loose?.severity, loose?.rule_id],
    [false, "warning", "strict-mode"],
  );
  const bad = found.get("test/fixtures/bad.schema.json");
  assert.deepEqual([bad?.gate, bad?.severity], [false, "note"]);
  // Only the draft-04 schema.
  assert.equal(gatesIn(s, "schema.compile").size, 1);
  assert.ok(
    s.limitations.some(
      (l) =>
        l.check_id === "schema.compile" &&
        l.path === "schemas/remote.schema.json",
    ),
    JSON.stringify(s.limitations),
  );
  assertNothingLeft(r);
});

test("a project without schemas has nothing to compile", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", "schema.compile"]);

  assert.equal(
    executionIn(parseReport(r), "schema.compile").applicability,
    "not_applicable",
  );
  assertNothingLeft(r);
});
