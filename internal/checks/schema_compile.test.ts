import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { classify, discover } from "../discovery/discovery.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { Implemented, lookup, PerProject } from "./catalog.ts";
import {
  impl,
  projectContext,
  tempDir,
  tree,
  writeTree,
} from "./checks.testutil.ts";
import { type SchemaTarget, schemaTargets } from "./schema_compile.ts";

function targetPaths(targets: readonly SchemaTarget[]): Record<string, string> {
  return Object.fromEntries(targets.map((x) => [x.path, x.draft]));
}

test("schema.compile is implemented for the project Context", () => {
  const e = lookup("schema.compile");
  assert.ok(e);
  assert.equal(e.status, Implemented);
  assert.equal(e.scope, PerProject);
  assert.equal(e.canFireGates, true);
});

test("every JSON or YAML file whose top-level $schema names a known draft is a target", (t) => {
  const proj = tree(t, {
    "package.json": '{"name":"x"}',
    "d4.json":
      '{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}',
    "d6.json":
      '{"$schema":"http://json-schema.org/draft-06/schema","type":"object"}',
    "d7.json": '{"$schema":"https://json-schema.org/draft-07/schema#"}',
    "d2019.yaml":
      "$schema: https://json-schema.org/draft/2019-09/schema\ntype: object\n",
    "d2020.yml":
      '"$schema": "https://json-schema.org/draft/2020-12/schema"\ntype: string\n',
    // Not targets: no $schema, an unknown draft, $schema below the top
    // level, a file that is not an object, a file that does not parse.
    "plain.json": '{"type":"object"}',
    "draft03.json": '{"$schema":"http://json-schema.org/draft-03/schema#"}',
    "tsconfig.json": '{"$schema":"https://json.schemastore.org/tsconfig"}',
    "nested.json":
      '{"definitions":{"a":{"$schema":"http://json-schema.org/draft-07/schema#"}}}',
    "list.json": '[{"$schema":"http://json-schema.org/draft-07/schema#"}]',
    "broken.json": '{"$schema":"http://json-schema.org/draft-07/schema#",',
    "notes.txt": '{"$schema":"http://json-schema.org/draft-07/schema#"}',
    "node_modules/dep/schema.json":
      '{"$schema":"http://json-schema.org/draft-07/schema#"}',
    // YAML that JSON cannot hold is no target either (Go's Marshal fails).
    "inf.yaml":
      "$schema: https://json-schema.org/draft/2020-12/schema\nmaximum: .inf\n",
  });
  assert.deepEqual(targetPaths(schemaTargets(proj)[0]), {
    "d2019.yaml": "2019-09",
    "d2020.yml": "2020-12",
    "d4.json": "draft-04",
    "d6.json": "draft-06",
    "d7.json": "draft-07",
  });
});

test("a YAML schema is handed over as JSON", (t) => {
  const proj = tree(t, {
    "s.yaml":
      "$schema: https://json-schema.org/draft/2020-12/schema\ntype: object\nrequired: [a]\nproperties:\n  a: {type: integer, default: 3}\n  1: {when: 2026-11-02}\n",
  });
  const [targets] = schemaTargets(proj);
  assert.equal(targets.length, 1);
  assert.equal(
    Buffer.from(targets[0]?.schema ?? []).toString("utf8"),
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"1":{"when":"2026-11-02 00:00:00 +0000 UTC"},"a":{"default":3,"type":"integer"}},"required":["a"],"type":"object"}',
  );
});

test("a YAML schema's JSON is json.Marshal's: HTML escaped, uint64 and floats as Go writes them", (t) => {
  const proj = tree(t, {
    "html.yaml":
      '$schema: https://json-schema.org/draft/2020-12/schema\ndescription: "<a> & b"\nbig: 18446744073709551615\nf: 1.5e300\nz: -0.0\n',
  });
  // Recorded from the Go build.
  assert.equal(
    Buffer.from(schemaTargets(proj)[0][0]?.schema ?? []).toString("utf8"),
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","big":18446744073709551615,"description":"\\u003ca\\u003e \\u0026 b","f":1.5e+300,"z":-0}',
  );
});

test("schema targets are read safely", (t) => {
  const dir = writeTree(t, {
    "ok.json": '{"$schema":"http://json-schema.org/draft-07/schema#"}',
    "big.json":
      '{"$schema":"http://json-schema.org/draft-07/schema#","pad":"' +
      "x".repeat(4 << 20) +
      '"}',
  });
  const proj = discover(dir);
  const outside = join(tempDir(t), "secret.json");
  writeFileSync(
    outside,
    '{"$schema":"http://json-schema.org/draft-07/schema#"}',
  );
  symlinkSync(outside, join(dir, "link.json"));
  // The Project was discovered without the link; add it as the Snapshot
  // would list it.
  proj.files.push({
    path: "link.json",
    packageRel: "link.json",
    class: classify("link.json"),
    contextID: "",
  });
  assert.deepEqual(targetPaths(schemaTargets(proj)[0]), {
    "ok.json": "draft-07",
  });
});

test("schema targets stay within the total budget", (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 1005; i++) {
    files[`s/${String(i).padStart(5, "0")}.json`] =
      '{"$schema":"http://json-schema.org/draft-07/schema#"}';
  }
  const [targets, skipped] = schemaTargets(tree(t, files));
  assert.equal(targets.length, 1000);
  assert.equal(skipped.length, 5);
});

test("schema.compile applies only when the project has a schema", (t) => {
  const withSchema = tree(t, {
    "s.json": '{"$schema":"http://json-schema.org/draft-07/schema#"}',
  });
  assert.deepEqual(
    impl("schema.compile").applicability(
      withSchema,
      projectContext(withSchema),
    ),
    [Applicable, ""],
  );
  const without = tree(t, {
    "package.json": '{"name":"x"}',
    "data.json": '{"a":1}',
  });
  const [got, reason] = impl("schema.compile").applicability(
    without,
    projectContext(without),
  );
  assert.equal(got, NotApplicable);
  assert.notEqual(reason, "");
});
