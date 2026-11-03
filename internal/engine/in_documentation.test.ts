// in_documentation of Findings: the central step that sets in_test_code sets
// it too, for the Finding of every Check, from the File class of the primary
// location.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { discover, type Project } from "../discovery/discovery.ts";
import type { Finding } from "../resultset/types.ts";
import { newFinding, newLocation } from "../resultset/zero.ts";
import { tempDir, writeTree } from "./engine.testutil.ts";
import { markFileClasses } from "./testcode.ts";

function docsProject(t: TestContext): Project {
  const root = tempDir(t);
  const files: Record<string, string> = {};
  for (const rel of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "src/index.js",
    "src/notes.txt",
    "docs/how-to.md",
    "docs/openapi.yaml",
    "docs/example.js",
    "doc/example.json",
    "test/notes.md",
    "test/helper.js",
    "fixtures/docs/broken.json",
    "dist/README.md",
    "sub/package.json",
    "sub/docs/schema.json",
  ]) {
    files[rel] = "{}\n";
  }
  writeTree(root, files);
  return discover(root);
}

function findingAt(check: string, ...paths: string[]): Finding {
  return newFinding({
    id: paths[0] ?? "",
    check_id: check,
    locations: paths.map((path, i) =>
      newLocation({
        role: i === 0 ? "primary" : "related",
        path_base: "project_root",
        path,
      }),
    ),
  });
}

test("every Finding whose primary location is Documentation is marked, whatever Check made it", (t) => {
  const findings = [
    findingAt("security.secrets", "README.md"),
    findingAt("security.secrets", "docs/how-to.md"),
    findingAt("artifacts.structured", "docs/openapi.yaml"),
    findingAt("api.lint", "doc/example.json"),
    findingAt("schema.compile", "sub/docs/schema.json"),
    findingAt("security.secrets", "test/notes.md"),
    findingAt("security.secrets", "src/notes.txt"),
    findingAt("lint.correctness", "lib/gone/docs/removed.json"),
  ];
  markFileClasses(docsProject(t), [], findings);
  assert.deepEqual(
    findings.map((f) => f.in_documentation),
    [true, true, true, true, true, true, true, true],
  );
  // A prose file in a test folder is Documentation and not Test code.
  assert.deepEqual(
    findings.map((f) => f.in_test_code),
    findings.map(() => false),
  );
});

test("Findings outside Documentation stay unmarked", (t) => {
  const findings = [
    findingAt("lint.correctness", "docs/example.js"),
    findingAt("lint.correctness", "src/index.js"),
    findingAt("security.secrets", "test/helper.js"),
    findingAt("security.secrets", "fixtures/docs/broken.json"),
    findingAt("artifacts.structured", "dist/README.md"),
    findingAt("package.manifest", "package.json"),
    newFinding({ id: "no location" }),
    newFinding({
      id: "only a related location",
      locations: [newLocation({ role: "related", path: "README.md" })],
    }),
    findingAt("security.secrets", "src/index.js", "README.md"),
  ];
  markFileClasses(docsProject(t), [], findings);
  assert.ok(findings.every((f) => !f.in_documentation));
});

test("a Test code Finding is not Documentation, and the two flags never both come from one file", (t) => {
  const findings = [
    findingAt("lint.correctness", "test/helper.js"),
    findingAt("security.secrets", "test/notes.md"),
  ];
  markFileClasses(docsProject(t), [], findings);
  assert.deepEqual(
    findings.map((f) => [f.in_test_code, f.in_documentation]),
    [
      [true, false],
      [false, true],
    ],
  );
});

test("a file the test file probe found is Source code or Test code, never Documentation", (t) => {
  const findings = [findingAt("lint.correctness", "docs/example.js")];
  markFileClasses(
    docsProject(t),
    [
      {
        contextID: "C-0002",
        path: "docs/example.js",
        suite: "scripts.test",
        kind: "require",
      },
    ],
    findings,
  );
  const f = findings[0];
  assert.ok(f);
  assert.deepEqual([f.in_test_code, f.in_documentation], [true, false]);
});

test("a flag a Check set itself is never cleared", (t) => {
  const f = findingAt("security.secrets", "src/index.js");
  f.in_documentation = true;
  markFileClasses(docsProject(t), [], [f]);
  assert.ok(f.in_documentation);
});
