// A generator script is a script with a generator-like name whose command
// is a plain `node <file>` call. The scripts of the package.json are the
// only input; nothing is run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { generatorScripts } from "./discovery.ts";

const scripts = (o: Record<string, string>) => new Map(Object.entries(o));

test("generator scripts are found by name and by a plain node command", () => {
  const got = generatorScripts(
    scripts({
      swagger2schema: "node scripts/swagger2schema.js",
      "gen:schema": "node ./tools/gen.mjs --out schemas --pretty",
      generate: "NODE_ENV=production API_URL='http://localhost:1' node gen.cjs",
      "generate-docs": "node docs/gen.js",
      codegen: "node codegen.js",
      "openapi:types": "node tools/types.js",
      "Build:Schema": "node tools/case.js",
    }),
  );
  assert.deepEqual(
    got.map((g) => [g.name, g.file, g.args, Object.fromEntries(g.env)]),
    [
      ["Build:Schema", "tools/case.js", [], {}],
      ["codegen", "codegen.js", [], {}],
      ["gen:schema", "tools/gen.mjs", ["--out", "schemas", "--pretty"], {}],
      [
        "generate",
        "gen.cjs",
        [],
        { NODE_ENV: "production", API_URL: "http://localhost:1" },
      ],
      ["generate-docs", "docs/gen.js", [], {}],
      ["openapi:types", "tools/types.js", [], {}],
      ["swagger2schema", "scripts/swagger2schema.js", [], {}],
    ],
  );
});

test("scripts without a generator name or with any other command are ignored", () => {
  const cases: [string, string][] = [
    ["lint", "node scripts/schema-lint.js"],
    ["gen:schema", "node scripts/a.js && node scripts/b.js"],
    ["gen:a", "node scripts/a.js | tee out.txt"],
    ["gen:b", "node scripts/a.js > out.json"],
    ["gen:c", "node scripts/a.js; echo done"],
    ["gen:d", "node scripts/$FILE.js"],
    ["gen:e", "node `echo a.js`"],
    ["gen:f", "(node a.js)"],
    ["gen:g", "node a.js &"],
    ["gen:h", "npm run gen:a"],
    ["gen:i", "sh scripts/gen.sh"],
    ["gen:j", "cross-env FOO=1 node a.js"],
    ["gen:k", "node -e \"require('./a')\""],
    ["gen:l", "node --require ./hook.js a.js"],
    ["gen:m", "node"],
    ["gen:n", "node a.json"],
    ["gen:o", "node /opt/gen.js"],
    ["gen:p", "node ../outside/gen.js"],
    ["gen:q", "node a.ts"],
    ["gen:r", "tsx a.js"],
    ["gen:s", "FOO=1"],
    ["gen:t", "node 'unterminated.js"],
    ["gen:u", ""],
  ];
  for (const [name, script] of cases) {
    assert.deepEqual(
      generatorScripts(scripts({ [name]: script })),
      [],
      `${name} = ${script}`,
    );
  }
});

test("npm lifecycle names are never generator scripts", () => {
  const input: Record<string, string> = {};
  for (const b of ["prepare", "install", "test", "start", "build"]) {
    for (const p of ["", "pre", "post"])
      input[p + b] = "node scripts/generate-schema.js";
  }
  input["build:schema"] = "node scripts/generate-schema.js";
  assert.deepEqual(
    generatorScripts(scripts(input)).map((g) => g.name),
    ["build:schema"],
    "only build:schema, which is not a lifecycle name",
  );
});
