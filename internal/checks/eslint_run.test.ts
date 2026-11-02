// The files and the input of the combined ESLint run (Go: eslint_run_test.go).
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { marshalAny } from "../gocompat/marshal_any.ts";
import { Applicable, NotApplicable } from "../resultset/types.ts";
import { ToolBin } from "../toolvolume/toolvolume.ts";
import "./all.ts";
import { Implemented, lookup, PerPackage } from "./catalog.ts";
import { impl, packageContext, writeTree } from "./checks.testutil.ts";
import { eslintProblems } from "./eslint.testutil.ts";
import {
  eslintHelperDocument,
  eslintHelperInput,
  eslintMaxFileBytes,
  eslintTargets,
} from "./eslint_run.ts";
import { Input } from "./input.ts";

function inputAt(
  t: Parameters<typeof writeTree>[0],
  files: Record<string, string>,
  path = ".",
): Input {
  const dir = writeTree(t, files);
  const proj = discover(dir);
  return new Input({
    project: proj,
    context: packageContext(proj, path),
    snapshotDir: dir,
  });
}

test("lint.correctness is implemented per package and never fires Gates", () => {
  const entry = lookup("lint.correctness");
  assert.equal(entry?.status, Implemented);
  assert.equal(entry.scope, PerPackage);
  assert.equal(entry.canFireGates, false, "it reports warnings, never Gates");
});

test("lint.correctness applies to packages with JavaScript outside Test data and Build output", (t) => {
  const { proj } = eslintProblems();
  const check = impl("lint.correctness");

  const [got, reason] = check.applicability(proj, packageContext(proj, "."));
  assert.equal(got, Applicable, reason);
  const project = proj.contexts[0];
  assert.ok(project);
  assert.equal(
    check.applicability(proj, project)[0],
    NotApplicable,
    "the project Context holds no package to lint",
  );

  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "test/fixtures/a.js": "debugger;\n",
    "dist/bundle.js": "debugger;\n",
    "src/app.ts": "export {};\n",
    "README.md": "# x\n",
  });
  const bare = discover(dir);
  const [none, why] = check.applicability(bare, packageContext(bare, "."));
  assert.equal(none, NotApplicable);
  assert.notEqual(why, "");
});

describe("only JavaScript of Source and Test code is linted with the source type of its package", () => {
  const cases: [string, string, string][] = [
    ["no type field", "", "commonjs"],
    ["commonjs", ',"type":"commonjs"', "commonjs"],
    ["module", ',"type":"module"', "module"],
  ];
  for (const [name, packageType, wantJS] of cases) {
    test(name, (t) => {
      const input = inputAt(t, {
        "package.json": `{"name":"x"${packageType}}`,
        "src/a.js": "1;\n",
        "src/b.mjs": "1;\n",
        "src/c.cjs": "1;\n",
        "src/d.ts": "1;\n",
        "src/e.jsx": "1;\n",
        "test/a.test.js": "1;\n",
        "test/fixtures/f.js": "1;\n",
        "dist/g.js": "1;\n",
        "src/h.min.js": "1;\n",
      });

      const got = Object.fromEntries(
        eslintTargets(input).map((f) => [f.path, f.source_type]),
      );

      assert.deepEqual(got, {
        "src/a.js": wantJS,
        "src/b.mjs": "module",
        "src/c.cjs": "commonjs",
        "test/a.test.js": wantJS,
      });
    });
  }
});

test("targets of a nested package are relative to its folder and leave out the outer package", (t) => {
  const input = inputAt(
    t,
    {
      "package.json": '{"name":"root"}',
      "src/root.js": "1;\n",
      "packages/inner/package.json": '{"name":"inner","type":"module"}',
      "packages/inner/src/in.js": "1;\n",
    },
    "packages/inner",
  );

  assert.deepEqual(eslintTargets(input), [
    { path: "src/in.js", source_type: "module" },
  ]);
});

test("symbolic links are never given to ESLint", (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "src/real.js": "1;\n",
  });
  symlinkSync("/etc/passwd", join(dir, "src", "link.js"));
  const proj = discover(dir);
  const input = new Input({
    project: proj,
    context: packageContext(proj, "."),
    snapshotDir: dir,
  });

  assert.deepEqual(
    eslintTargets(input).map((f) => f.path),
    ["src/real.js"],
    "the real file only",
  );
});

describe("Mocha globals apply to Test code of packages that name Mocha", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    [
      "test script",
      { "package.json": '{"scripts":{"test":"mocha --recursive"}}' },
      true,
    ],
    [
      "test script the tool does not parse, mocha a devDependency",
      {
        "package.json":
          '{"scripts":{"test":"NODE_ENV=test npx mocha"},"devDependencies":{"mocha":"*"}}',
      },
      true,
    ],
    [
      "mocharc json",
      {
        "package.json": '{"scripts":{"test":"npm run unit"}}',
        ".mocharc.json": "{}",
      },
      true,
    ],
    [
      "mocharc cjs",
      { "package.json": "{}", ".mocharc.cjs": "module.exports = {};" },
      true,
    ],
    [
      "test script delegating through npm run, mocha a devDependency",
      {
        "package.json":
          '{"scripts":{"test":"npm run test:unit && npm run test:api","test:unit":"mocha --config test/config/mocha-unit.js"},"devDependencies":{"mocha":"^10.0.0"}}',
      },
      true,
    ],
    [
      "mocha a dependency",
      {
        "package.json":
          '{"scripts":{"test":"npm run unit && npm run api"},"dependencies":{"mocha":"^10.0.0"}}',
      },
      true,
    ],
    [
      "mocha only a peer dependency",
      { "package.json": '{"peerDependencies":{"mocha":"*"}}' },
      false,
    ],
    [
      "mocha-like dependency",
      {
        "package.json":
          '{"devDependencies":{"mocha-multi-reporters":"^1.0.0"}}',
      },
      false,
    ],
    [
      "node test runner",
      { "package.json": '{"scripts":{"test":"node --test"}}' },
      false,
    ],
    [
      "a word that only contains mocha",
      { "package.json": '{"scripts":{"test":"echo mochalike"}}' },
      false,
    ],
    [
      "mocha in another script",
      { "package.json": '{"scripts":{"test":"jest","lint":"mocha-lint"}}' },
      false,
    ],
    ["nothing", { "package.json": "{}" }, false],
    ["broken manifest", { "package.json": "{" }, false],
  ];
  for (const [name, files, mocha] of cases) {
    test(name, (t) => {
      const input = inputAt(t, {
        "test/a.test.js": "1;\n",
        "src/a.js": "1;\n",
        ...files,
      });

      const helper = eslintHelperInput(input, [], ToolBin);

      assert.equal(helper.mocha, mocha);
      assert.deepEqual(helper.testFiles, ["test/a.test.js"], "only Test code");
    });
  }
});

test("an oversized file is not given to ESLint but is listed as skipped", (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "src/small.js": "1;\n",
  });
  writeFileSync(join(dir, "src", "big.js"), " ".repeat(eslintMaxFileBytes + 1));
  const proj = discover(dir);
  const input = new Input({
    project: proj,
    context: packageContext(proj, "."),
    snapshotDir: dir,
  });

  const helper = eslintHelperInput(input, [], ToolBin);

  assert.deepEqual(
    helper.files.map((f) => f.path),
    ["src/small.js"],
  );
  assert.deepEqual(helper.oversized, ["src/big.js"]);
});

test("the helper's document has Go's field order, names and null options", (t) => {
  const input = inputAt(t, {
    "package.json": '{"name":"x","type":"module"}',
    "src/a.js": "1;\n",
    "test/a.test.js": "1;\n",
  });
  const helper = eslintHelperInput(
    input,
    [
      {
        checkID: "lint.correctness",
        coreProblem: true,
        except: ["b", "a"],
        coreOptions: new Map([["no-unused-vars", [new Map([["z", "^_"]])]]]),
        rules: [
          { name: "n/b" },
          { name: "n/a", options: [1], measure: "length" },
        ],
      },
    ],
    ToolBin,
  );

  assert.equal(
    marshalAny(eslintHelperDocument(helper)),
    '{"eslint":"/toolset/node_modules/eslint","globals":"/toolset/node_modules/globals","tools":"/toolset/node_modules","root":"/snapshot",' +
      '"groups":[{"id":"lint.correctness","core_problem":true,"except":["a","b"],"core_options":{"no-unused-vars":[{"z":"^_"}]},"plugins":[],' +
      '"rules":[{"name":"n/a","options":[1],"measure":"length"},{"name":"n/b","options":null}],"test_only":false,"source_only":false,"settings":{}}],' +
      '"files":[{"path":"src/a.js","source_type":"module"},{"path":"test/a.test.js","source_type":"module"}],' +
      '"test_files":["test/a.test.js"],"source_files":["src/a.js"],"mocha":false}',
  );
});
