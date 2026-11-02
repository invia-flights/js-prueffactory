import assert from "node:assert/strict";
import { test } from "node:test";

import { Shared } from "./shared.ts";
import { StatusCompleted } from "../resultset/types.ts";
import {
  binaryRunsDependency,
  commandBinaries,
  correctKnip,
  dockerfileRunLines,
  gitlabScriptLines,
  mochaConfigFiles,
  namedByQuotedString,
  quotedStrings,
  resolveFromPackage,
} from "./quality_unused_mocha.ts";
import { interpretKnip } from "./quality_unused.ts";
import { testFilesKey } from "./test_files_probe.ts";
import {
  foundNames,
  knipMochaOutput,
  mochaKnipInput,
  removeFile,
  writeFile,
} from "./quality_unused.testutil.ts";

void test("Mocha configs come from any script's config option and .mocharc files", () => {
  const scripts = new Map([
    ["test", "npm run test:unit && npm run test:api"],
    ["test:unit", "mocha --config test/config/mocha-unit.js"],
    [
      "test:api",
      "NODE_ENV=test mocha --exit --config=./test/config/mocha-api.js 'test/api/**/*.test.js'",
    ],
    [
      "test:legacy",
      "cross-env FOO=1 _mocha --recursive --config .config/legacy.cjs",
    ],
    ["lint", "eslint --config eslint.config.js ."],
    [
      "outside",
      "mocha --config ../shared/mocha.js && mocha --config /etc/mocha.js",
    ],
    ["colors", "mocha -c test/a.js"],
  ]);
  const files = [
    ".mocharc.yml",
    "package.json",
    "sub/.mocharc.json",
    "test/config/mocha-unit.js",
  ];
  assert.deepEqual(mochaConfigFiles(scripts, files), [
    ".config/legacy.cjs",
    ".mocharc.yml",
    "test/config/mocha-api.js",
    "test/config/mocha-unit.js",
  ]);
});

void test("Mocha require paths resolve from the package folder with Node's extensions", () => {
  const files = new Set([
    "test/setup/base.js",
    "test/setup/data.json",
    "test/setup/esm.mjs",
    "test/setup/dir/index.js",
    "test/setup/exact",
    "lib/a.js",
  ]);
  const exists = (p: string): boolean => files.has(p);
  const cases: [string, string | undefined][] = [
    ["test/setup/base.js", "test/setup/base.js"],
    ["./test/setup/base", "test/setup/base.js"],
    ["test/setup/data", "test/setup/data.json"],
    ["test/setup/esm.mjs", "test/setup/esm.mjs"],
    ["test/setup/dir", "test/setup/dir/index.js"],
    ["test/setup/exact", "test/setup/exact"],
    ["./test/../lib/a", "lib/a.js"],
    ["test/setup/missing", undefined],
    ["test/setup", undefined],
    ["../test/setup/base.js", undefined],
    ["/test/setup/base.js", undefined],
    ["", undefined],
    ["..", undefined],
    ["mocha-multi-reporters", undefined],
    ["./test/setup/../../../x", undefined],
  ];
  for (const [spec, want] of cases) {
    assert.equal(resolveFromPackage(exists, spec), want, spec);
  }
});

void test("quoted strings of a config file", () => {
  const js =
    "module.exports = {\n  reporter: 'mocha-multi-reporters',\n  r2: \"@scope/reporter\",\n  r3: `tpl-reporter`,\n  r4: `no-${interp}`,\n  bare: unquoted-word,\n};\n";
  let got = quotedStrings(".mocharc.js", Buffer.from(js));
  for (const want of [
    "mocha-multi-reporters",
    "@scope/reporter",
    "tpl-reporter",
  ]) {
    assert.ok(got.has(want), want);
  }
  assert.ok(!got.has("unquoted-word") && !got.has("no-${interp}"));

  // YAML has no need for quotes, so its scalars are all strings of the config.
  const yml =
    "reporter: mocha-multi-reporters\nrequire:\n  - ts-node/register\nexit: true\n";
  got = quotedStrings(".mocharc.yml", Buffer.from(yml));
  assert.ok(got.has("mocha-multi-reporters") && got.has("ts-node/register"));

  got = quotedStrings(
    ".mocharc.json",
    Buffer.from(`{"reporter":"json-reporter","require":["a","b/c"]}`),
  );
  assert.ok(got.has("json-reporter") && got.has("b/c"));
});

void test("a package is named by an exact quoted string or one of its subpaths", () => {
  const quoted = new Set([
    "mocha-multi-reporters",
    "chai/register-expect",
    "@scope/pkg",
    "other-pkg-extra",
  ]);
  const cases: [string, boolean][] = [
    ["mocha-multi-reporters", true],
    ["chai", true],
    ["@scope/pkg", true],
    ["other-pkg", false],
    ["mocha", false],
    ["@scope/other", false],
    ["multi", false],
  ];
  for (const [dep, want] of cases) {
    assert.equal(namedByQuotedString(quoted, dep), want, dep);
  }
});

void test("command binaries are the first word of a command after npx, env assignments and exec", () => {
  const cases: [string, string[]][] = [
    ["npx c8 --reporter=text npm test", ["c8"]],
    ["c8 mocha", ["c8"]],
    ["FOO=1 BAR=2 c8 mocha", ["c8"]],
    ["exec c8 node x.js", ["c8"]],
    ["exec npx c8", ["c8"]],
    ["cd app && c8 mocha | tee out.txt", ["c8", "cd", "tee"]],
    ["./node_modules/.bin/c8 mocha", ["c8"]],
    ["npx --yes -p typescript tsc --noEmit", ["tsc"]],
    ["echo c8 is nice", ["echo"]],
    ["$compose run --rm nodejs npx c8 npm test", ["$compose", "c8"]],
    ["if true; then nyc mocha; fi", ["fi", "if", "nyc"]],
    ["npm exec -- c8 mocha", ["c8"]],
    ["", []],
    ["# c8 is only in a comment", []],
    ["docker compose run --rm app npx eslint src/", ["docker", "eslint"]],
    ["VAR=1", []],
    ["npx", []],
    ["sudo -u build c8 mocha", ["sudo"]],
  ];
  for (const [line, want] of cases) {
    assert.deepEqual(commandBinaries(line).sort(), want, line);
  }
});

void test("a devDependency is run by its package name as binary", () => {
  const bins = new Set(["c8", "tool"]);
  const cases: [string, boolean][] = [
    ["c8", true],
    ["@scope/tool", true],
    ["tool", true],
    ["mocha", false],
    ["@scope/c9", false],
  ];
  for (const [dep, want] of cases) {
    assert.equal(binaryRunsDependency(bins, dep), want, dep);
  }
});

void test("Dockerfile run lines are the commands after RUN", () => {
  const df =
    'FROM node:24\n# RUN c8 in a comment\nRUN npm ci \\\n  && npx c8 mocha\nRUN --mount=type=cache,target=/x  nyc report\nrun lowercase-tool x\nRUN ["exec-form", "x"]\nCMD ["c8", "mocha"]\nCOPY c8 /c8\n';
  assert.deepEqual(dockerfileRunLines(df), [
    "npm ci   && npx c8 mocha",
    "nyc report",
    "lowercase-tool x",
  ]);
});

void test("GitLab CI script lines are every script entry", () => {
  const ci = `
stages: [test]
default:
  before_script:
    - npm ci
test:
  stage: test
  script:
    - npx c8 mocha
    - |
      cd app
      nyc report
  after_script: report-tool x
  variables:
    NOT_A_SCRIPT: c8 mocha
`;
  assert.deepEqual(gitlabScriptLines(Buffer.from(ci)).sort(), [
    "cd app",
    "npm ci",
    "npx c8 mocha",
    "nyc report",
    "report-tool x",
  ]);
});

void test("unused dependency findings are dropped for reporters and CI binaries", (t) => {
  const input = mochaKnipInput(t);
  const { issues } = correctKnip(input, Buffer.from(knipMochaOutput));
  const deps = issues.flatMap((i) => i.dependencies.map((d) => d.name));
  const devDeps = issues.flatMap((i) => i.devDependencies.map((d) => d.name));
  // mocha-multi-reporters is a quoted string of test/config/common.js, which
  // the Mocha config requires, and c8 runs in ci/test.sh. is-odd is really
  // unused.
  assert.deepEqual(deps, ["is-odd"]);
  assert.deepEqual(devDeps, []);
});

void test("a devDependency run only in a Dockerfile or GitLab CI is used too", (t) => {
  for (const [name, content] of [
    ["Dockerfile", "FROM node:24\nRUN npx c8 mocha\n"],
    [".gitlab-ci.yml", "test:\n  script:\n    - c8 mocha\n"],
  ] as const) {
    const input = mochaKnipInput(t, (dir) => {
      removeFile(dir, "ci/test.sh");
      writeFile(dir, name, content);
    });
    const { issues } = correctKnip(input, Buffer.from(knipMochaOutput));
    for (const i of issues) {
      assert.ok(
        !i.devDependencies.some((d) => d.name === "c8"),
        `c8 runs in ${name}`,
      );
    }
  }
});

void test("a devDependency nobody runs is still reported", (t) => {
  const input = mochaKnipInput(t, (dir) => {
    removeFile(dir, "ci/test.sh");
  });
  const { issues } = correctKnip(input, Buffer.from(knipMochaOutput));
  assert.deepEqual(
    issues.flatMap((i) => i.devDependencies.map((d) => d.name)),
    ["c8"],
  );
});

void test("Knip findings of a Mocha config are corrected", (t) => {
  const input = mochaKnipInput(t);
  const res = interpretKnip(input, Buffer.from(knipMochaOutput));
  assert.equal(res.status, StatusCompleted, res.reason);
  // What Knip reports falsely is gone. What is really unused stays: the file
  // nothing loads, and the dependency nothing uses. The files that only the
  // setup files import are not reported by a first run, either: the second
  // run, with the setup files as entry files, decides that.
  const got = foundNames(res);
  for (const f of got) {
    assert.ok(
      !f.startsWith("unresolved-import"),
      `a false unresolved import: ${f}`,
    );
    assert.ok(
      !f.includes("mocha-multi-reporters") && !f.includes(" c8"),
      `a dependency that is used is reported: ${f}`,
    );
  }
  for (const want of [
    "unused-dependency package.json is-odd",
    "unused-file src/unused.js src/unused.js",
  ]) {
    assert.ok(got.includes(want), `${want} in ${got.join(" | ")}`);
  }
});

void test("Mocha-loaded files are the relative requires that exist from the package root", (t) => {
  const input = mochaKnipInput(t);
  const { loaded } = correctKnip(input, Buffer.from(knipMochaOutput));
  assert.deepEqual(loaded, [
    "test/setup/api.js",
    "test/setup/base.js",
    "test/setup/unit.js",
  ]);
});

// A config that names a setup file through a helper (`file: files.map(...)`)
// gives Knip no unresolved import to learn it from. The test file probe asked
// Mocha itself, so what it found under `file`, `require` or `import` is loaded
// by Mocha as well, and an unused-file Finding for it is false.
// A Suite whose command names a folder (`mocha test/modules`, with `recursive`
// in the config) loads specs that Knip never learns of, and it reports every
// one of them, and the sources only they import, as unused. The spec files the
// probe found and Knip reported are loaded by Mocha, so they become entry
// files of the second run. A spec that Knip did not report needs no entry.
void test("spec files that Knip reports as unused are Mocha-loaded and become entries of the second run", (t) => {
  const input = mochaKnipInput(t, (dir) => {
    for (const f of [
      "test/modules/deep/a.test.js",
      "test/modules/deep/b.test.js",
    ]) {
      writeFile(dir, f, "it('x', () => {});\n");
    }
  });
  input.shared = new Shared();
  input.shared.put(testFilesKey(input.context.id), {
    files: [
      {
        contextID: input.context.id,
        path: "test/modules/deep/a.test.js",
        suite: "scripts.test",
        kind: "spec",
      },
      {
        contextID: input.context.id,
        path: "test/modules/deep/b.test.js",
        suite: "scripts.test",
        kind: "spec",
      },
    ],
  });
  const report = `{"issues":[{"file":"test/modules/deep/a.test.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/modules/deep/a.test.js"}]},
 {"file":"src/unused.js","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"src/unused.js"}]}]}`;

  const { loaded } = correctKnip(input, Buffer.from(report));
  assert.deepEqual(loaded, ["test/modules/deep/a.test.js"]);
  // Whatever the second run still reports for a loaded spec is dropped.
  const res = interpretKnip(input, Buffer.from(report));
  assert.deepEqual(foundNames(res), [
    "unused-file src/unused.js src/unused.js",
  ]);
});

void test("files the probe found under file, require and import are Mocha-loaded too", (t) => {
  const input = mochaKnipInput(t, (dir) => {
    writeFile(dir, "test/setup/late.mjs", "export {};\n");
  });
  input.shared = new Shared();
  input.shared.put(testFilesKey(input.context.id), {
    files: [
      {
        contextID: input.context.id,
        path: "test/setup/late.mjs",
        suite: "test:api",
        kind: "file",
      },
      {
        contextID: input.context.id,
        path: "test/api/a.test.js",
        suite: "test:api",
        kind: "spec",
      },
      {
        contextID: input.context.id,
        path: "test/setup/missing.js",
        suite: "test:api",
        kind: "require",
      },
    ],
  });
  const lateOnly = `{"issues":[{"file":"test/setup/late.mjs","dependencies":[],"devDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"files":[{"name":"test/setup/late.mjs"}]}]}`;

  const { loaded } = correctKnip(input, Buffer.from(lateOnly));
  assert.deepEqual(loaded, ["test/setup/late.mjs"]);
  assert.deepEqual(foundNames(interpretKnip(input, Buffer.from(lateOnly))), []);
});

// Project text is scanned for quoted strings and imports, and the patterns
// run over files of up to 16 MiB: none of them may take more than linear time.
void test("project text of an adversarial shape is scanned in linear time", (t) => {
  const n = 1 << 20;
  const shapes = [
    "from" + " ".repeat(n),
    "require(" + " ".repeat(n),
    "import" + "\t".repeat(n),
    ("from " + "import ").repeat(n / 12),
    '"' + "a'".repeat(n / 2),
    ("'" + "x".repeat(199) + '"').repeat(n / 200),
    "RUN" + " ".repeat(n) + "x",
    "\r".repeat(n) + "x",
    "&&".repeat(n / 2),
  ];
  for (const text of shapes) {
    const started = performance.now();
    quotedStrings("test/config/x.js", Buffer.from(text));
    commandBinaries(text);
    dockerfileRunLines(text);
    dockerfileRunLines(text.replaceAll(" ", "\\\n"));
    const took = performance.now() - started;
    assert.ok(
      took < 5000,
      `scanning ${text.slice(0, 20)} took ${String(took)} ms`,
    );
  }
  // The require scan runs over a config the package names, and over the
  // local modules that config requires.
  const input = mochaKnipInput(t, (dir) => {
    writeFile(dir, "test/config/evil.js", shapes.slice(0, 4).join("\n"));
    writeFile(
      dir,
      ".mocharc.js",
      "require('./test/config/evil');\n" + shapes.slice(0, 4).join("\n"),
    );
  });
  const started = performance.now();
  correctKnip(input, Buffer.from(knipMochaOutput));
  const took = performance.now() - started;
  assert.ok(took < 5000, `the require scan took ${String(took)} ms`);
});
