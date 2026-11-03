// The files a runner loads become Test code: a view of the project with
// those files reclassified. The project itself is never changed, because
// Checks that do not wait for the probe read it at the same time.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fileOf, project } from "./discovery.testutil.ts";
import {
  BuildOutput,
  Documentation,
  type FileClass,
  type Project,
  Source,
  TestCode,
  TestData,
  type TestFile,
} from "./discovery.ts";

function loadedProject(): Project {
  return project({
    "package.json": '{"scripts":{"test":"mocha"}}',
    "src/a.spec.js": "",
    "src/setup.js": "",
    "src/ab-test.js": "",
    "test/fixtures/data.js": "",
    "test/b.js": "",
    "dist/c.js": "",
    "sub/package.json": "{}",
    "sub/src/d.spec.js": "",
    "sub/src/e.js": "",
    "node_modules/dep/index.js": "",
    "sub/node_modules/dep/index.js": "",
  });
}

function classOf(p: Project, rel: string): FileClass {
  return fileOf(p, rel).class;
}

function pkgClassOf(p: Project, pkg: string, rel: string): FileClass {
  const f = p.packages
    .find((x) => x.path === pkg)
    ?.files.find((x) => x.path === rel);
  assert.ok(f, `package ${pkg} has no file ${rel}`);
  return f.class;
}

function contextID(p: Project, i: number): string {
  const c = p.contexts[i];
  assert.ok(c);
  return c.id;
}

test("files the runner loads become Test code in a view, and the project stays as it was", () => {
  const proj = loadedProject();
  const root = contextID(proj, 1);
  const view = proj.withTestFiles([
    {
      contextID: root,
      path: "src/a.spec.js",
      suite: "scripts.test",
      kind: "spec",
    },
    {
      contextID: root,
      path: "src/setup.js",
      suite: "scripts.test",
      kind: "require",
    },
  ]);
  for (const rel of ["src/a.spec.js", "src/setup.js"]) {
    assert.equal(classOf(view, rel), TestCode, `view: ${rel}`);
    assert.equal(pkgClassOf(view, ".", rel), TestCode, `view package: ${rel}`);
    assert.equal(classOf(proj, rel), Source, `project: ${rel} must not change`);
    assert.equal(pkgClassOf(proj, ".", rel), Source, `project package: ${rel}`);
  }
  assert.equal(
    classOf(view, "src/ab-test.js"),
    Source,
    "no file becomes Test code by its name",
  );
});

test("the view's Contexts point to the packages of the view", () => {
  const proj = loadedProject();
  const root = contextID(proj, 1);
  const view = proj.withTestFiles([
    {
      contextID: root,
      path: "src/a.spec.js",
      suite: "scripts.test",
      kind: "spec",
    },
  ]);
  const c = view.contextByID(root);
  assert.ok(c?.package);
  assert.equal(
    c.package.files.find((f) => f.path === "src/a.spec.js")?.class,
    TestCode,
    "the view's Context does not see the reclassified file",
  );
  assert.ok(
    view.contextByID(contextID(proj, 0)),
    "the project Context is missing from the view",
  );
});

test("only Source code inside the package becomes Test code, and Test data wins", () => {
  const proj = loadedProject();
  const root = contextID(proj, 1);
  const sub = contextID(proj, 2);
  const view = proj.withTestFiles([
    {
      contextID: root,
      path: "test/fixtures/data.js",
      suite: "scripts.test",
      kind: "spec",
    },
    {
      contextID: root,
      path: "dist/c.js",
      suite: "scripts.test",
      kind: "require",
    },
    {
      contextID: root,
      path: "sub/src/d.spec.js",
      suite: "scripts.test",
      kind: "spec",
    },
    {
      contextID: root,
      path: "node_modules/dep/index.js",
      suite: "scripts.test",
      kind: "require",
    },
    {
      contextID: root,
      path: "missing.js",
      suite: "scripts.test",
      kind: "require",
    },
    {
      contextID: sub,
      path: "sub/src/e.js",
      suite: "scripts.test",
      kind: "spec",
    },
  ]);
  const want: Record<string, FileClass> = {
    "test/fixtures/data.js": TestData,
    "dist/c.js": BuildOutput,
    "sub/src/d.spec.js": Source,
    "sub/src/e.js": TestCode,
    "src/a.spec.js": Source,
    "test/b.js": TestCode,
  };
  for (const [rel, cls] of Object.entries(want))
    assert.equal(classOf(view, rel), cls, rel);
  assert.equal(view.files.length, proj.files.length, "no file may be added");
});

test("the probe never moves a Documentation file, a prose file in a test folder or a non-code file in docs", () => {
  const proj = project({
    "package.json": '{"scripts":{"test":"mocha"}}',
    "docs/guide.md": "",
    "docs/example.js": "",
    "test/notes.md": "",
    "test/b.js": "",
    "src/notes.txt": "",
  });
  const root = contextID(proj, 1);
  const loaded: TestFile[] = [
    "docs/guide.md",
    "docs/example.js",
    "test/notes.md",
    "test/b.js",
    "src/notes.txt",
  ].map((path) => ({
    contextID: root,
    path,
    suite: "scripts.test",
    kind: "require",
  }));
  const view = proj.withTestFiles(loaded);
  const want: Record<string, FileClass> = {
    "docs/guide.md": Documentation,
    "docs/example.js": TestCode, // code below docs is Source code: it moves
    "test/notes.md": Documentation,
    "test/b.js": TestCode,
    "src/notes.txt": Documentation,
  };
  for (const [rel, cls] of Object.entries(want)) {
    assert.equal(classOf(view, rel), cls, rel);
    assert.equal(pkgClassOf(view, ".", rel), cls, `package: ${rel}`);
  }
  const pkg = proj.packages[0];
  assert.ok(pkg);
  assert.deepEqual(
    proj.movedTestFiles(pkg, loaded).map((l) => l.path),
    ["docs/example.js"],
    "only the code file is reported as moved",
  );
});

test("moved test files are the Source files of the package the runner loads", () => {
  const proj = loadedProject();
  const root = proj.contexts[1];
  assert.ok(root?.package);
  const loaded: TestFile[] = [
    {
      contextID: root.id,
      path: "src/a.spec.js",
      suite: "test:unit",
      kind: "spec",
    },
    {
      contextID: root.id,
      path: "src/setup.js",
      suite: "test:unit",
      kind: "require",
    },
    { contextID: root.id, path: "test/b.js", suite: "test:unit", kind: "spec" }, // already Test code
    {
      contextID: root.id,
      path: "test/fixtures/data.js",
      suite: "test:unit",
      kind: "spec",
    }, // Test data
    {
      contextID: root.id,
      path: "sub/src/d.spec.js",
      suite: "test:unit",
      kind: "spec",
    }, // another package
    {
      contextID: root.id,
      path: "src/a.spec.js",
      suite: "test:api",
      kind: "spec",
    }, // a second suite
    {
      contextID: root.id,
      path: "src/a.spec.js",
      suite: "test:api",
      kind: "spec",
    }, // listed twice
  ];
  const moved = proj.movedTestFiles(root.package, loaded);
  assert.deepEqual(moved.map((m) => `${m.suite}|${m.path}|${m.kind}`).sort(), [
    "test:api|src/a.spec.js|spec",
    "test:unit|src/a.spec.js|spec",
    "test:unit|src/setup.js|require",
  ]);
});
