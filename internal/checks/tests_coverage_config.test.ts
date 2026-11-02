// c8 wraps the runner with a config file that we write, never with options
// built from project paths: a path cannot become an option, and a glob
// character in a path cannot widen an exclusion (Go:
// tests_coverage_config_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BuildOutput,
  type File,
  type FileClass,
  Package,
  Project,
  Source,
  TestCode,
  TestData,
} from "../discovery/discovery.ts";
import {
  coverageConfig,
  coverageDir,
  coverageTmp,
  suiteCoverageConfig,
  wrapWithC8,
} from "./tests_coverage_config.ts";

interface C8Doc {
  all: boolean;
  src: string[];
  reporter: string[];
  reportsDir: string;
  tempDirectory: string;
  clean: boolean;
  exclude: string[];
}

function projectOf(...packages: Package[]): Project {
  const p = new Project("/p");
  p.packages = packages;
  return p;
}

function c8DocOf(proj: Project, pkg: Package): C8Doc {
  return JSON.parse(coverageConfig(proj, pkg).toString("utf8")) as C8Doc;
}

function c8File(path: string, rel: string, cls: FileClass): File {
  return { path, packageRel: rel, class: cls, contextID: "" };
}

test("c8 measures every file of the package root and writes JSON summary and per-file reports", () => {
  const pkg = new Package(".");
  const doc = c8DocOf(projectOf(pkg), pkg);

  assert.equal(doc.all, true);
  assert.deepEqual(doc.src, ["/work"]);
  assert.deepEqual(doc.reporter, ["json-summary", "json"]);
  assert.equal(doc.reportsDir, coverageDir);
  assert.equal(doc.tempDirectory, coverageTmp);
  assert.equal(doc.clean, false);
});

test("c8 excludes Test code, Test data, Build output and node_modules but not Source code", () => {
  const pkg = new Package("packages/api");
  pkg.files = [
    c8File("packages/api/src/index.js", "src/index.js", Source),
    c8File("packages/api/test/index.test.js", "test/index.test.js", TestCode),
    c8File("packages/api/src/helper.spec.js", "src/helper.spec.js", TestCode),
    c8File(
      "packages/api/test/fixtures/data.js",
      "test/fixtures/data.js",
      TestData,
    ),
    c8File("packages/api/dist/index.js", "dist/index.js", BuildOutput),
  ];

  const doc = c8DocOf(projectOf(pkg), pkg);

  assert.deepEqual(doc.src, ["/work/packages/api"]);
  for (const want of [
    "test/index.test.js",
    "src/helper.spec.js",
    "test/fixtures/data.js",
    "dist/index.js",
    "**/node_modules/**",
    "**/*.min.js",
    "**/fixtures/**",
    "**/__fixtures__/**",
    "**/testdata/**",
    "**/__mocks__/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/spec/**",
  ]) {
    assert.ok(doc.exclude.includes(want), `exclude lacks ${want}`);
  }
  assert.ok(!doc.exclude.includes("src/index.js"), "Source code is excluded");
});

test("c8 leaves the files of nested packages to their own Context", () => {
  const root = new Package(".");
  const child = new Package("packages/api");
  const sibling = new Package("packages/api-extra");
  const proj = projectOf(root, child, sibling);

  const rootExclude = c8DocOf(proj, root).exclude;
  assert.ok(rootExclude.includes("packages/api"));
  assert.ok(rootExclude.includes("packages/api-extra"));

  const childExclude = c8DocOf(proj, child).exclude;
  for (const bad of ["packages/api", "packages/api-extra", "../api-extra"]) {
    assert.ok(
      !childExclude.includes(bad),
      `a package excludes a package that is not below it: ${bad}`,
    );
  }
});

test("c8 exclusions take glob characters and leading bangs of paths literally", () => {
  const pkg = new Package(".");
  pkg.files = [
    "test/[id].test.js",
    "test/*.js",
    "!x.test.js",
    "#y.test.js",
    "test/{a,b}.js",
    "test/a b.js",
  ].map((p) => c8File(p, p, TestCode));

  const doc = c8DocOf(projectOf(pkg), pkg);

  for (const want of [
    String.raw`test/\[id\].test.js`,
    String.raw`test/\*.js`,
    String.raw`\!x.test.js`,
    String.raw`\#y.test.js`,
    String.raw`test/\{a,b\}.js`,
    "test/a b.js",
  ]) {
    assert.ok(doc.exclude.includes(want), `exclude lacks ${want}`);
  }
  for (const bad of [
    "test/[id].test.js",
    "test/*.js",
    "!x.test.js",
    "#y.test.js",
    "test/{a,b}.js",
  ]) {
    assert.ok(
      !doc.exclude.includes(bad),
      `exclude holds the unescaped ${bad}, which is a glob or a negation`,
    );
  }
});

test("c8 wraps the runner after a double dash so that its own options are never the project's", () => {
  const got = wrapWithC8([
    "node",
    "/work/node_modules/mocha/bin/mocha.js",
    "--reporter",
    "/jspf/mocha-reporter.js",
    "-r",
    "x",
  ]);

  assert.deepEqual(got, [
    "node",
    "/toolset/node_modules/c8/bin/c8.js",
    "--config",
    "/jspf/c8.json",
    "--",
    "node",
    "/work/node_modules/mocha/bin/mocha.js",
    "--reporter",
    "/jspf/mocha-reporter.js",
    "-r",
    "x",
  ]);
});

test("the c8 of a suite only collects into the shared temp directory and keeps what the suites before it wrote", () => {
  const pkg = new Package(".");
  const proj = projectOf(pkg);
  const doc = JSON.parse(
    suiteCoverageConfig(proj, pkg).toString("utf8"),
  ) as C8Doc;

  assert.equal(doc.tempDirectory, coverageTmp);
  assert.equal(doc.clean, false);
  assert.equal(doc.all, false);
  assert.notEqual(doc.reportsDir, coverageDir);
  assert.deepEqual(doc.exclude, c8DocOf(proj, pkg).exclude);
});

test("the config document is Go's: keys in sorted order, one line", () => {
  const pkg = new Package(".");
  const text = coverageConfig(projectOf(pkg), pkg).toString("utf8");
  assert.ok(!text.includes("\n"));
  assert.deepEqual(Object.keys(JSON.parse(text) as object), [
    "all",
    "clean",
    "exclude",
    "reporter",
    "reportsDir",
    "src",
    "tempDirectory",
  ]);
});
