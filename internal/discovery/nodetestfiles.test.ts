// The files a `node --test` suite runs, from its file arguments or, without
// any, from Node's documented default patterns. The package files are given
// relative to the package folder.
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import { nodeTestFiles } from "./discovery.ts";

function sorted(s: readonly string[]): string[] {
  return [...s].sort(compareBytes);
}

test("node --test without file arguments uses Node's default patterns", () => {
  const files = [
    "index.js",
    "a.test.js",
    "b.test.mjs",
    "c.test.cjs",
    "d-test.js",
    "e_test.js",
    "test-f.js",
    "test.js",
    "src/g.test.js",
    "src/deep/h-test.mjs",
    "ab-test.txt", // not a JavaScript file
    "fare-upgrade-ab.js", // no test in its name
    "latest.js", // "test" only as a suffix of a word
    "contest.js", // ends in "test" without a separator
    "test/helper.js", // inside a folder named test: every JavaScript file
    "test/deep/more.cjs", // also nested
    "test/data.json", // not JavaScript
    "src/test/inner.mjs", // a folder named test at any depth
    "node_modules/x/a.test.js",
    "testing/readme.js",
  ];
  assert.deepEqual(
    sorted(nodeTestFiles(files, ["--test"])),
    sorted([
      "a.test.js",
      "b.test.mjs",
      "c.test.cjs",
      "d-test.js",
      "e_test.js",
      "test-f.js",
      "test.js",
      "src/g.test.js",
      "src/deep/h-test.mjs",
      "test/helper.js",
      "test/deep/more.cjs",
      "src/test/inner.mjs",
    ]),
  );
});

test("node --test with file arguments runs exactly those files", async (t) => {
  const files = [
    "src/a.spec.js",
    "src/b.spec.js",
    "src/sub/c.spec.js",
    "src/ab-test.js",
    "test/x.js",
    "tools/run.js",
    "node_modules/m/m.spec.js",
  ];
  const cases: [string, string[], string[]][] = [
    ["a file", ["--test", "src/a.spec.js"], ["src/a.spec.js"]],
    ["a file with ./", ["--test", "./src/a.spec.js"], ["src/a.spec.js"]],
    [
      "a glob",
      ["--test", "src/**/*.spec.js"],
      ["src/a.spec.js", "src/b.spec.js", "src/sub/c.spec.js"],
    ],
    [
      "a one-level glob",
      ["--test", "src/*.spec.js"],
      ["src/a.spec.js", "src/b.spec.js"],
    ],
    [
      "braces",
      ["--test", "src/{a,b}.spec.js"],
      ["src/a.spec.js", "src/b.spec.js"],
    ],
    [
      "two arguments",
      ["--test", "src/a.spec.js", "tools/run.js"],
      ["src/a.spec.js", "tools/run.js"],
    ],
    [
      "options with values are not files",
      [
        "--test",
        "--test-reporter",
        "spec",
        "--import",
        "./setup.js",
        "src/a.spec.js",
      ],
      ["src/a.spec.js"],
    ],
    [
      "after a double dash",
      ["--test", "--", "src/b.spec.js"],
      ["src/b.spec.js"],
    ],
    ["a file that does not exist", ["--test", "src/missing.spec.js"], []],
    [
      "node_modules is not searched by a glob",
      ["--test", "**/*.spec.js"],
      ["src/a.spec.js", "src/b.spec.js", "src/sub/c.spec.js"],
    ],
    [
      "an explicit file argument is not named by its name",
      ["--test", "tools/run.js"],
      ["tools/run.js"],
    ],
  ];
  for (const [name, args, want] of cases) {
    await t.test(name, () => {
      assert.deepEqual(sorted(nodeTestFiles(files, args)), sorted(want));
    });
  }
});

test("node --test defaults are the suite's only, and options do not count as file arguments", () => {
  // Without file arguments, only options: still the defaults.
  assert.deepEqual(
    nodeTestFiles(
      ["a.test.js", "plain.js"],
      ["--test", "--test-concurrency=1", "--import", "./setup.js"],
    ),
    ["a.test.js"],
  );
});
