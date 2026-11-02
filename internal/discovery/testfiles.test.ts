import assert from "node:assert/strict";
import { test } from "node:test";

import { fileOf, project } from "./discovery.testutil.ts";
import {
  type FileClass,
  type Project,
  RunnerMocha,
  RunnerNodeTest,
  Source,
  type TestRunner,
  type TestSetup,
  TestCode,
  TestData,
} from "./discovery.ts";

function testsOf(
  files: Record<string, string>,
  pkgPath: string,
): TestSetup | null {
  const proj = project(files);
  const p = proj.packages.find((x) => x.path === pkgPath);
  assert.ok(p, `no package ${pkgPath}`);
  return p.tests;
}

test("a package runs Mocha from its test script or its Mocha config", async (t) => {
  const placeholder =
    '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}';
  const cases: [string, Record<string, string>, TestRunner | null, string][] = [
    [
      "test script",
      { "package.json": '{"scripts":{"test":"mocha --exit"}}' },
      RunnerMocha,
      "scripts.test",
    ],
    [
      "mocharc json without a script",
      { "package.json": "{}", ".mocharc.json": "{}" },
      RunnerMocha,
      ".mocharc.json",
    ],
    [
      "mocharc yml",
      { "package.json": "{}", ".mocharc.yml": "exit: true\n" },
      RunnerMocha,
      ".mocharc.yml",
    ],
    [
      "mocharc cjs",
      { "package.json": "{}", ".mocharc.cjs": "module.exports = {};\n" },
      RunnerMocha,
      ".mocharc.cjs",
    ],
    [
      "the script wins over the config",
      {
        "package.json": '{"scripts":{"test":"node --test"}}',
        ".mocharc.json": "{}",
      },
      RunnerNodeTest,
      "scripts.test",
    ],
    [
      "npm init placeholder with a config",
      { "package.json": placeholder, ".mocharc.json": "{}" },
      RunnerMocha,
      ".mocharc.json",
    ],
    ["npm init placeholder", { "package.json": placeholder }, null, ""],
    [
      "no test script",
      { "package.json": '{"scripts":{"start":"node ."}}' },
      null,
      "",
    ],
    [
      "a nested config does not count",
      { "package.json": "{}", "test/.mocharc.json": "{}" },
      null,
      "",
    ],
  ];
  for (const [name, files, runner, origin] of cases) {
    await t.test(name, () => {
      const got = testsOf(files, ".");
      if (runner === null) {
        assert.equal(got, null);
        return;
      }
      assert.equal(got?.unsupported, null);
      assert.deepEqual(
        got.suites.map((s) => [s.runner, s.origin]),
        [[runner, origin]],
      );
    });
  }
});

test("a package with an unsupported runner says why", () => {
  const got = testsOf(
    { "package.json": '{"scripts":{"test":"jest --ci"}}' },
    ".",
  );
  assert.equal(got?.unsupported?.code, "test_runner_unsupported");
  assert.ok(got.unsupported.reason.includes("jest --ci"));
});

test("each package reads its own test script", () => {
  const proj = project({
    "package.json": '{"scripts":{"test":"mocha"}}',
    "sub/package.json": '{"scripts":{"test":"node --test"}}',
  });
  assert.deepEqual(
    proj.packages.map((p) => [p.path, p.tests?.suites[0]?.runner]),
    [
      [".", RunnerMocha],
      ["sub", RunnerNodeTest],
    ],
  );
});

function assertClasses(proj: Project, want: Record<string, FileClass>): void {
  for (const [path, cls] of Object.entries(want)) {
    assert.equal(fileOf(proj, path).class, cls, path);
  }
  // The package's own copy of the file list agrees with the project's.
  for (const p of proj.packages) {
    for (const f of p.files) {
      const w = want[f.path];
      if (w !== undefined)
        assert.equal(f.class, w, `package copy of ${f.path}`);
    }
  }
}

test("files the runner loads are Test code", () => {
  const proj = project({
    "package.json": `{"scripts":{"test":"mocha 'checks/api' 'checks/unit/**/*.js' --require ./setup/globals.js --file lib/boot.js --config ci/mocha.js"}}`,
    // loaded: a directory (not recursive), a glob, --require, --file
    "checks/api/a.js": "",
    "checks/api/deep/b.js": "",
    "checks/api/readme.md": "",
    "checks/unit/x/c.js": "",
    "checks/unit/d.js": "",
    "setup/globals.js": "",
    "lib/boot.js": "",
    // not loaded
    "src/app.js": "",
    "ci/mocha.js": "",
    "checks/other.js": "",
    // Test data wins over Test code
    "checks/unit/fixtures/e.js": "",
  });
  assertClasses(proj, {
    "checks/api/a.js": TestCode,
    "checks/api/deep/b.js": Source,
    "checks/api/readme.md": Source,
    "checks/unit/x/c.js": TestCode,
    "checks/unit/d.js": TestCode,
    "setup/globals.js": TestCode,
    "lib/boot.js": TestCode,
    "src/app.js": Source,
    "ci/mocha.js": Source,
    "checks/other.js": Source,
    "checks/unit/fixtures/e.js": TestData,
  });
});

test("Mocha config files name the test files too", () => {
  const proj = project({
    "package.json": "{}",
    ".mocharc.yaml":
      "spec:\n  - 'suites/**/*.spec.js'\nrequire: helpers/setup.js\n",
    "suites/a/b.spec.js": "",
    "suites/a/not-a-spec.js": "",
    "helpers/setup.js": "",
  });
  assertClasses(proj, {
    "suites/a/b.spec.js": TestCode,
    "suites/a/not-a-spec.js": Source,
    "helpers/setup.js": TestCode,
  });
});

test("recursive directories and braces are followed", () => {
  const proj = project({
    "package.json": `{"scripts":{"test":"mocha --recursive e2e 'unit/**/*.{js,mjs}'"}}`,
    "e2e/a.js": "",
    "e2e/deep/b.mjs": "",
    "e2e/deep/c.txt": "",
    "unit/x/y.mjs": "",
    "unit/z.js": "",
    "unit/z.cjs": "",
  });
  assertClasses(proj, {
    "e2e/a.js": TestCode,
    "e2e/deep/b.mjs": TestCode,
    "e2e/deep/c.txt": Source,
    "unit/x/y.mjs": TestCode,
    "unit/z.js": TestCode,
    "unit/z.cjs": Source,
  });
});

test("every chain suite names its own test files", () => {
  const proj = project({
    "package.json": `{"scripts":{"test":"npm run unit && npm run api","unit":"mocha checks/unit --require ./setup/unit.js","api":"mocha 'checks/api/**/*.js'"}}`,
    "checks/unit/a.js": "",
    "setup/unit.js": "",
    "checks/api/b.js": "",
    "checks/api/deep/c.js": "",
    "src/app.js": "",
  });
  assertClasses(proj, {
    "checks/unit/a.js": TestCode,
    "setup/unit.js": TestCode,
    "checks/api/b.js": TestCode,
    "checks/api/deep/c.js": TestCode,
    "src/app.js": Source,
  });
});
