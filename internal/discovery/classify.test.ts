// The File class of a path: Documentation next to the classes that
// discovery.test.ts already covers by folder names.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BuildOutput,
  classify,
  Documentation,
  type FileClass,
  folderNames,
  Source,
  TestCode,
  TestData,
} from "./classify.ts";

test("every prose extension is Documentation, wherever the file is", () => {
  for (const ext of [".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]) {
    assert.equal(classify(`guide${ext}`), Documentation, `guide${ext}`);
    assert.equal(classify(`src/deep/er/note${ext}`), Documentation, ext);
  }
  assert.equal(classify("README.md"), Documentation);
  assert.equal(classify("CHANGELOG.md"), Documentation);
  assert.equal(classify("requirements.txt"), Documentation);
});

test("the extension is read without regard to case", () => {
  assert.equal(classify("README.MD"), Documentation);
  assert.equal(classify("docs/Guide.RST"), Documentation);
});

test("other extensions, and names that only look like prose, stay Source code", () => {
  const want: Record<string, FileClass> = {
    "src/app.js": Source,
    "package.json": Source,
    "openapi.yaml": Source,
    Dockerfile: Source,
    LICENSE: Source,
    "notes.md.bak": Source,
    md: Source,
    "src/readme.mdx.js": Source,
    "src/txt/app.js": Source,
  };
  for (const [path, cls] of Object.entries(want)) {
    assert.equal(classify(path), cls, path);
  }
});

test("a file below a docs or doc folder is Documentation at any depth", () => {
  for (const path of [
    "docs/openapi.yaml",
    "doc/example.json",
    "docs/how-to/example.json",
    "packages/app/docs/schema.json",
    "a/b/c/doc/d/e/config.yml",
    "docs/Makefile",
    "docs/images/diagram.png",
  ]) {
    assert.equal(classify(path), Documentation, path);
  }
});

test("only a folder named exactly docs or doc counts", () => {
  for (const path of [
    "documents/a.json",
    "docs-old/a.json",
    "my-docs/a.json",
    "Docs/a.json",
    "src/docs.json",
    "docs", // a file called docs
  ]) {
    assert.equal(classify(path), Source, path);
  }
});

test("JavaScript and TypeScript files below docs stay code", () => {
  for (const ext of [
    ".js",
    ".cjs",
    ".mjs",
    ".jsx",
    ".ts",
    ".cts",
    ".mts",
    ".tsx",
  ]) {
    assert.equal(classify(`docs/example${ext}`), Source, `docs/example${ext}`);
    assert.equal(classify(`a/doc/b/example${ext}`), Source, ext);
  }
  assert.equal(classify("docs/Example.JS"), Source);
  // A declaration file is TypeScript.
  assert.equal(classify("docs/types.d.ts"), Source);
  // Prose next to that code is still Documentation.
  assert.equal(classify("docs/example.md"), Documentation);
});

test("JavaScript under docs follows the other folder names", () => {
  assert.equal(classify("docs/test/example.js"), TestCode);
  assert.equal(classify("test/docs/example.js"), TestCode);
});

// The precedence, from strongest: Test data, Build output, Documentation,
// Test code, Source code. Each row is a pair where the first class must win.
test("precedence pairs", () => {
  const pairs: [string, FileClass][] = [
    // Test data over Build output, Documentation, Test code.
    ["fixtures/dist/a.js", TestData],
    ["dist/fixtures/a.js", TestData],
    ["fixtures/docs/example.json", TestData],
    ["docs/fixtures/example.json", TestData],
    ["fixtures/guide.md", TestData],
    ["test/fixtures/a.js", TestData],
    // Build output over Documentation, Test code.
    ["dist/guide.md", BuildOutput],
    ["build/docs/example.json", BuildOutput],
    ["docs/build/example.json", BuildOutput],
    ["coverage/README.txt", BuildOutput],
    ["test/dist/a.js", BuildOutput],
    // Documentation over Test code.
    ["test/notes.md", Documentation],
    ["tests/docs/example.json", Documentation],
    ["docs/tests/example.json", Documentation],
    ["spec/guide.rst", Documentation],
    ["__tests__/readme.txt", Documentation],
    // Test code over Source code.
    ["test/a.js", TestCode],
    ["test/data.json", TestCode],
    // Source code last.
    ["src/a.js", Source],
  ];
  for (const [path, cls] of pairs) {
    assert.equal(classify(path), cls, path);
  }
});

test("the folders that make Documentation are listed, sorted", () => {
  assert.deepEqual(folderNames(Documentation), ["doc", "docs"]);
});
