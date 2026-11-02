import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasOwnKnipConfig,
  knipConfigWithEntries,
  knipSecondRunConfig,
} from "./quality_unused_knip_config.ts";
import { interpretKnip } from "./quality_unused.ts";
import {
  foundNames,
  knipMochaOutput,
  mochaKnipInput,
  writeFile,
} from "./quality_unused.testutil.ts";

void test("the generated Knip config keeps the default entries and adds the Mocha-loaded files", () => {
  const data = knipConfigWithEntries([
    "test/setup/base.js",
    "test/setup/[id].js",
    "test/setup/*.js",
    "-x.js",
    "test/setup/a b.js",
  ]);
  const cfg = JSON.parse(data.toString()) as { entry: string[] };
  // A name with a glob character would be read as a pattern, and a name that
  // starts with a dash is not a path: neither becomes an entry.
  assert.deepEqual(cfg.entry, [
    "{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
    "src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
    "test/setup/base.js",
    "test/setup/a b.js",
  ]);
});

void test("the generated config is written as Go's json.Marshal writes it", () => {
  assert.equal(
    knipConfigWithEntries(["a&b<c>.js"]).toString(),
    '{"entry":["{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!","src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!","a\\u0026b\\u003cc\\u003e.js"]}',
  );
});

void test("a project's own Knip config is recognised", (t) => {
  for (const name of [
    "knip.json",
    "knip.jsonc",
    ".knip.json",
    ".knip.jsonc",
    "knip.ts",
    "knip.js",
    "knip.config.ts",
    "knip.config.js",
  ]) {
    const input = mochaKnipInput(t, (dir) => {
      writeFile(dir, name, "{}");
    });
    assert.ok(hasOwnKnipConfig(input), `${name} is a Knip config`);
  }
  const keyed = mochaKnipInput(t, (dir) => {
    writeFile(dir, "package.json", `{"name":"x","knip":{"entry":["a.js"]}}`);
  });
  assert.ok(
    hasOwnKnipConfig(keyed),
    'a "knip" key in package.json is a Knip config',
  );
  const nulled = mochaKnipInput(t, (dir) => {
    writeFile(dir, "package.json", `{"name":"x","knip":null}`);
  });
  assert.ok(!hasOwnKnipConfig(nulled), 'a "knip": null is none');
  assert.ok(
    !hasOwnKnipConfig(mochaKnipInput(t)),
    "the testdata project has no Knip config",
  );
});

void test("without a Knip config the Mocha-loaded files get a generated one for a second run", (t) => {
  const input = mochaKnipInput(t);
  const cfg = knipSecondRunConfig(input, Buffer.from(knipMochaOutput));
  assert.ok(cfg, "the report holds Mocha-loaded files, so Knip runs again");
  for (const want of [
    "test/setup/base.js",
    "test/setup/unit.js",
    "test/setup/api.js",
  ]) {
    assert.ok(cfg.toString().includes(`"${want}"`), `config lacks ${want}`);
  }
  assert.equal(
    knipSecondRunConfig(input, Buffer.from(`{"issues":[]}`)),
    undefined,
    "nothing was loaded by Mocha, so Knip does not run again",
  );
});

void test("with the project's own Knip config there is no second run", (t) => {
  const input = mochaKnipInput(t, (dir) => {
    writeFile(dir, "knip.json", `{"ignore":["src/unused.js"]}`);
  });
  assert.equal(
    knipSecondRunConfig(input, Buffer.from(knipMochaOutput)),
    undefined,
  );
});

void test("with the project's own Knip config unused-file findings of Mocha-loaded files are dropped with a Limitation", (t) => {
  const input = mochaKnipInput(t, (dir) => {
    writeFile(dir, "knip.json", "{}");
  });
  const res = interpretKnip(input, Buffer.from(knipMochaOutput));
  const got = foundNames(res);
  for (const f of got) {
    assert.ok(
      !f.startsWith("unused-file test/setup/"),
      `a file Mocha loads is reported as unused: ${f}`,
    );
  }
  // The file that only the setup files import cannot be told from here.
  for (const want of [
    "unused-file src/unused.js src/unused.js",
    "unused-file test/helpers/only-setup.js test/helpers/only-setup.js",
  ]) {
    assert.ok(got.includes(want), `${want} in ${got.join(" | ")}`);
  }
  const limits = (res.limitations ?? []).filter(
    (l) =>
      l.reason_code === "mocha_loaded_files_not_traced" &&
      l.check_id === "quality.unused",
  );
  assert.equal(limits.length, 1);
  assert.ok(limits[0]?.message.includes("test/setup/base.js"));
  assert.ok(limits[0]?.message.includes("only they import"));
});

void test("without a Knip config there is no Limitation about Mocha-loaded files", (t) => {
  const res = interpretKnip(mochaKnipInput(t), Buffer.from(knipMochaOutput));
  assert.deepEqual(res.limitations ?? [], []);
});
