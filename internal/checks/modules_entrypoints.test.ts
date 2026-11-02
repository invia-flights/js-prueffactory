import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nodeScriptFile,
  productionEntryPoints,
  reachedFrom,
} from "./modules_entrypoints.ts";

/** covered is the set of files a cruise covers in the entry-point tests. */
function covered(...files: string[]): Set<string> {
  return new Set(files);
}

const all = covered(
  "index.js",
  "server.js",
  "lib/main.js",
  "lib/index.js",
  "lib/esm.mjs",
  "lib/cjs.cjs",
  "lib/node.js",
  "lib/features/a.js",
  "lib/features/b.js",
  "bin/cli.js",
  "bin/other.js",
  "src/start.js",
);

const cases: [
  name: string,
  manifest: string,
  files: Set<string>,
  want: string[],
][] = [
  ["main", `{"main": "server.js"}`, all, ["server.js"]],
  [
    "main with ./ and without extension",
    `{"main": "./lib/main"}`,
    all,
    ["lib/main.js"],
  ],
  ["main naming a folder", `{"main": "lib"}`, all, ["lib/index.js"]],
  ["index.js when main is missing", `{"name": "x"}`, all, ["index.js"]],
  [
    "no index.js default when main is missing and index.js is not covered",
    `{"name": "x"}`,
    covered("server.js"),
    [],
  ],
  [
    "no index.js default when main is set",
    `{"main": "server.js"}`,
    all,
    ["server.js"],
  ],
  [
    "exports as a string",
    `{"main": "server.js", "exports": "./lib/main.js"}`,
    all,
    ["server.js", "lib/main.js"],
  ],
  [
    "nested exports conditions",
    `{"main": "server.js", "exports": {
			".": {"import": "./lib/esm.mjs", "require": {"node": "./lib/node.js", "default": "./lib/cjs.cjs"}},
			"./package.json": "./package.json",
			"./internal": null,
			"./alt": ["./lib/main.js", "./lib/index.js"]}}`,
    all,
    [
      "server.js",
      "lib/cjs.cjs",
      "lib/esm.mjs",
      "lib/index.js",
      "lib/main.js",
      "lib/node.js",
    ],
  ],
  [
    "exports pattern",
    `{"main": "server.js", "exports": {"./features/*": "./lib/features/*.js"}}`,
    all,
    ["server.js", "lib/features/a.js", "lib/features/b.js"],
  ],
  [
    "bin as a string",
    `{"main": "server.js", "bin": "./bin/cli.js"}`,
    all,
    ["server.js", "bin/cli.js"],
  ],
  [
    "bin as an object",
    `{"main": "server.js", "bin": {"b": "bin/other.js", "a": "bin/cli.js"}}`,
    all,
    ["server.js", "bin/cli.js", "bin/other.js"],
  ],
  [
    "start with Node options",
    `{"main": "server.js", "scripts": {"start": "node --max-old-space-size=4096 -r dotenv/config --enable-source-maps src/start.js --port 80"}}`,
    all,
    ["server.js", "src/start.js"],
  ],
  [
    "start without extension",
    `{"main": "server.js", "scripts": {"start": "node src/start"}}`,
    all,
    ["server.js", "src/start.js"],
  ],
  [
    "start that is not plain node",
    `{"main": "server.js", "scripts": {"start": "npm run build && node src/start.js"}}`,
    all,
    ["server.js"],
  ],
  [
    "start that evaluates code",
    `{"main": "server.js", "scripts": {"start": "node -e \\"require('./src/start.js')\\""}}`,
    all,
    ["server.js"],
  ],
  [
    "start through another program",
    `{"main": "server.js", "scripts": {"start": "nodemon src/start.js"}}`,
    all,
    ["server.js"],
  ],
  [
    "a target that is the same file twice is listed once",
    `{"main": "./server.js", "exports": "./server.js", "scripts": {"start": "node server.js"}}`,
    all,
    ["server.js"],
  ],
  [
    "missing targets are ignored",
    `{"main": "gone.js", "exports": {".": "./dist/index.js"}, "bin": {"x": "bin/gone.js"}, "scripts": {"start": "node gone.js"}}`,
    covered("server.js"),
    [],
  ],
  // Node loads index.js when `main` names no file (DEP0128).
  [
    "index.js when main names a missing file",
    `{"main": "gone.js"}`,
    all,
    ["index.js"],
  ],
  [
    "index.js when main names a missing folder",
    `{"main": "./gone/"}`,
    all,
    ["index.js"],
  ],
  [
    "targets outside the package are ignored",
    `{"main": "../server.js", "bin": "/bin/cli.js"}`,
    all,
    [],
  ],
  ["package.json that is not JSON", `{"main": `, all, []],
  // Node ignores a `main` that is not a string and loads index.js.
  [
    "fields of the wrong type",
    `{"main": 3, "exports": 4, "bin": [1], "scripts": {"start": 5}}`,
    all,
    ["index.js"],
  ],
];

void test("production entry points", async (t) => {
  for (const [name, manifest, files, want] of cases) {
    await t.test(name, () => {
      const got = productionEntryPoints(Buffer.from(manifest), files, (p) =>
        files.has(p),
      );
      assert.deepEqual(got, want);
    });
  }
});

// A `main` that names a file the cruise does not cover, such as Build output,
// is what Node loads, so index.js is no entry point then.
void test("no index.js when main names a file the cruise does not cover", () => {
  const onDisk = covered("index.js", "dist/server.js");
  const got = productionEntryPoints(
    Buffer.from(`{"main": "dist/server"}`),
    covered("index.js"),
    (p) => onDisk.has(p),
  );
  assert.deepEqual(got, []);
});

// Go decodes package.json with encoding/json: keys match without regard to
// case, and a repeated key keeps the last value.
void test("package.json keys are read as Go reads them", () => {
  const got = productionEntryPoints(
    Buffer.from(`{"MAIN": "lib/main.js", "main": "server.js"}`),
    all,
    (p) => all.has(p),
  );
  assert.deepEqual(got, ["server.js"]);
});

void test("a deeply nested exports value does not overflow the stack", () => {
  const depth = 9000;
  const exports = "[".repeat(depth) + `"./lib/main.js"` + "]".repeat(depth);
  const got = productionEntryPoints(
    Buffer.from(`{"main": "server.js", "exports": ${exports}}`),
    all,
    (p) => all.has(p),
  );
  assert.deepEqual(got, ["server.js", "lib/main.js"]);
});

void test("reached files name the first entry point that reaches them", () => {
  const edges = new Map<string, string[]>([
    ["index.js", ["src/app.js"]],
    ["src/app.js", ["src/a.js", "src/lazy.js"]],
    ["src/a.js", ["src/b.js"]],
    ["src/b.js", ["src/a.js"]], // a cycle
    ["bin/cli.js", ["src/a.js", "src/cli-only.js"]],
    ["dev/generate.js", ["src/a.js", "dev/helper.js"]],
  ]);

  const got = reachedFrom(["index.js", "bin/cli.js"], edges);

  assert.deepEqual(
    [...got].sort(),
    [
      ["index.js", "index.js"],
      ["src/app.js", "index.js"],
      ["src/a.js", "index.js"],
      ["src/b.js", "index.js"],
      ["src/lazy.js", "index.js"],
      ["bin/cli.js", "bin/cli.js"],
      ["src/cli-only.js", "bin/cli.js"],
    ].sort(),
  );
});

void test("the file of a plain node script", () => {
  assert.equal(nodeScriptFile("node src/start.js --port 80"), "src/start.js");
  assert.equal(nodeScriptFile("NODE_ENV=production node -- app.js"), "app.js");
  assert.equal(nodeScriptFile("/usr/bin/node app.js"), "app.js");
  assert.equal(nodeScriptFile("node --test"), "");
  assert.equal(nodeScriptFile("node a.js | tee x"), "");
  assert.equal(nodeScriptFile("node"), "");
});
