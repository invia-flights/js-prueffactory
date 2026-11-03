// Seam B for the two native project Checks quality.size and
// quality.suppressions: they discover a testdata project, run the Check on it
// without Docker and look at the Result a Report is built from. The expected
// numbers were counted with wc, grep and shasum, not with the code under test
// (Go: inventory_checks_test.go).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { discover } from "../discovery/discovery.ts";
import {
  Applicable,
  type Inventory,
  StatusCompleted,
} from "../resultset/types.ts";
import "./all.ts";
import { Implemented, lookup, PerProject } from "./catalog.ts";
import { impl, projectContext, runCheck, tempDir } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { writeFiles } from "../testkit/fs.testutil.ts";

const suppressionsProject = join(
  import.meta.dirname,
  "..",
  "..",
  "testdata",
  "projects",
  "suppressions",
);

async function runNativeCheck(id: string, root: string): Promise<Result> {
  const proj = discover(root);
  const context = projectContext(proj);
  assert.deepEqual(impl(id).applicability(proj, context), [Applicable, ""], id);
  const res = await runCheck(
    id,
    new Input({
      project: proj,
      context,
      snapshotDir: root,
      originalPath: root,
    }),
  );
  assert.equal(res.status, StatusCompleted, `${id}: ${res.reason ?? ""}`);
  return res;
}

/** project writes files below a new folder. */
function project(t: TestContext, files: Record<string, string>): string {
  const root = tempDir(t);
  writeFiles(root, files);
  return root;
}

function metricsByName(res: Result): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of res.metrics ?? []) {
    if (x.value !== null) {
      m.set(x.name, x.value);
    }
  }
  return m;
}

function inventoryOf(res: Result): Inventory {
  assert.ok(res.inventory, "no Inventory contribution");
  return res.inventory;
}

function lines(n: number): string {
  return "x\n".repeat(n);
}

test("size and suppressions are implemented project Checks", () => {
  for (const id of ["quality.size", "quality.suppressions"]) {
    const e = lookup(id);
    assert.equal(e?.status, Implemented, id);
    assert.equal(e.scope, PerProject, id);
  }
});

test("size counts lines per File class and extension", async () => {
  const got = metricsByName(
    await runNativeCheck("quality.size", suppressionsProject),
  );
  const want: Record<string, number> = {
    "lines.file_class:source": 44,
    "non_blank_lines.file_class:source": 43,
    "lines.file_class:test_code": 9,
    "non_blank_lines.file_class:test_code": 9,
    "lines.file_class:test_data": 5,
    "non_blank_lines.file_class:test_data": 5,
    "lines.file_class:build_output": 2,
    "non_blank_lines.file_class:build_output": 2,
    // README.md is Documentation, not Source code.
    "lines.file_class:documentation": 3,
    "non_blank_lines.file_class:documentation": 2,
    "lines.extension:.json": 20,
    "non_blank_lines.extension:.json": 20,
    "lines.extension:.js": 33,
    "non_blank_lines.extension:.js": 32,
    "lines.extension:.md": 3,
    "non_blank_lines.extension:.md": 2,
    "lines.extension:.sh": 3,
    "lines.extension:.env": 1,
    "lines.extension:(none)": 3, // the Dockerfile
  };
  for (const [name, v] of Object.entries(want)) {
    assert.equal(got.get(name), v, `metric ${name}`);
  }
});

/**
 * writeMixedProject writes a package with code, a lockfile, an OpenAPI file,
 * Test data and Build output of known line counts.
 */
function writeMixedProject(t: TestContext): string {
  return project(t, {
    "package.json": '{"name":"p","scripts":{"test":"mocha"}}\n',
    "src/a.js": lines(30),
    "src/b.ts": lines(20),
    "src/c.mjs": lines(10),
    "src/d.cjs": lines(5),
    "src/e.jsx": lines(4),
    "src/f.cts": lines(3),
    "src/g.mts": lines(2),
    "src/h.tsx": lines(1),
    "src/schema.json": lines(500),
    "openapi.yaml": lines(400),
    "package-lock.json": lines(900),
    "test/app.test.js": lines(25),
    "test/fixtures/big.js": lines(300),
    "test/fixtures/data.json": lines(700),
    "dist/bundle.js": lines(800),
  });
}

test("the size code lines indicator counts only JavaScript and TypeScript files of Source code", async (t) => {
  const got = metricsByName(
    await runNativeCheck("quality.size", writeMixedProject(t)),
  );

  // 30+20+10+5+4+3+2+1: no JSON, YAML, lockfile, Test code, Test data or Build output.
  assert.equal(got.get("lines.source_code:javascript_typescript"), 75);
  // The per-class and per-extension counts stay as they were.
  const want: Record<string, number> = {
    "lines.file_class:source": 75 + 500 + 400 + 900 + 1, // the 1 is package.json
    "lines.file_class:test_code": 25,
    "lines.extension:.json": 500 + 900 + 700 + 1,
    "lines.extension:.yaml": 400,
    "lines.extension:.js": 30 + 25 + 300 + 800,
  };
  for (const [name, v] of Object.entries(want)) {
    assert.equal(got.get(name), v, name);
  }
});

test("size reports the lines of Documentation as their own class", async (t) => {
  const root = project(t, {
    "package.json": '{"name":"p"}\n',
    "src/a.js": lines(10),
    "README.md": lines(7),
    "docs/guide.txt": lines(5),
    "docs/openapi.yaml": lines(11),
    "docs/example.js": lines(3), // code below docs stays Source code
    "test/notes.md": lines(2),
    "fixtures/docs/broken.json": lines(4), // Test data wins
    "dist/README.md": lines(6), // Build output wins
  });
  const res = await runNativeCheck("quality.size", root);
  const got = metricsByName(res);
  assert.equal(got.get("lines.file_class:documentation"), 7 + 5 + 11 + 2);
  assert.equal(got.get("non_blank_lines.file_class:documentation"), 25);
  assert.equal(got.get("lines.file_class:source"), 1 + 10 + 3);
  assert.equal(got.get("lines.file_class:test_data"), 4);
  assert.equal(got.get("lines.file_class:build_output"), 6);
  assert.equal(got.has("lines.file_class:test_code"), false);
  // The side indicator counts code only: the example under docs/ is code, the
  // prose is not.
  assert.equal(got.get("lines.source_code:javascript_typescript"), 13);
  const docs = inventoryOf(res).size.find(
    (s) => s.group === "file_class" && s.name === "documentation",
  );
  assert.deepEqual([docs?.lines, docs?.non_blank_lines], [25, 25]);
});

test("the size code lines indicator is zero when Source code has no code", async (t) => {
  const root = project(t, {
    "package.json": '{"name":"p"}\n',
    "data.json": lines(10),
  });
  const got = metricsByName(await runNativeCheck("quality.size", root));
  assert.equal(got.get("lines.source_code:javascript_typescript"), 0);
});

test("size lists the largest JavaScript and TypeScript files of Source and Test code only", async (t) => {
  const res = await runNativeCheck("quality.size", writeMixedProject(t));
  const largest: string[] = [];
  for (const m of res.metrics ?? []) {
    const p = "largest_file:";
    if (m.name.startsWith(p)) {
      largest.push(m.name.slice(p.length));
      assert.equal(m.unit, "lines", m.name);
    }
  }
  // Largest first; no JSON, YAML, lockfile, Test data or Build output.
  assert.deepEqual(largest, [
    "src/a.js",
    "test/app.test.js",
    "src/b.ts",
    "src/c.mjs",
    "src/d.cjs",
    "src/e.jsx",
    "src/f.cts",
    "src/g.mts",
    "src/h.tsx",
  ]);
});

test("size stops at twenty largest files", async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 25; i++) {
    files[`src/${String.fromCharCode(97 + i)}.js`] = "x\n";
  }
  const res = await runNativeCheck("quality.size", project(t, files));
  const n = (res.metrics ?? []).filter((m) =>
    m.name.startsWith("largest_file:"),
  ).length;
  assert.equal(n, 20);
});

test("the size Inventory mirrors the metrics", async () => {
  const res = await runNativeCheck("quality.size", suppressionsProject);
  const inv = inventoryOf(res);
  const src = inv.size.find(
    (s) => s.group === "file_class" && s.name === "source",
  );
  const js = inv.size.find((s) => s.group === "extension" && s.name === ".js");
  assert.deepEqual(
    [src?.lines, src?.non_blank_lines],
    [44, 43],
    "source: 44 lines, 43 non-blank",
  );
  const docs = inv.size.find(
    (s) => s.group === "file_class" && s.name === "documentation",
  );
  assert.deepEqual(
    [docs?.lines, docs?.non_blank_lines],
    [3, 2],
    "documentation: 3 lines, 2 non-blank",
  );
  assert.deepEqual(
    [js?.lines, js?.non_blank_lines],
    [33, 32],
    ".js: 33 lines, 32 non-blank",
  );
});

test("size ignores binary files", async (t) => {
  const root = project(t, {
    "src/a.js": "one\ntwo",
    "src/logo.png": "\x89PNG\x00\x00\n\n\n\n",
  });
  const got = metricsByName(await runNativeCheck("quality.size", root));
  assert.equal(
    got.get("lines.file_class:source"),
    2,
    "an unterminated last line counts, a PNG does not",
  );
  assert.equal(
    got.has("lines.extension:.png"),
    false,
    "a binary extension has a line count",
  );
});

function suppressionCounts(inv: Inventory): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of inv.suppressions) {
    const key = `${s.kind} in ${s.file_class}`;
    m.set(key, (m.get(key) ?? 0) + s.count);
  }
  return m;
}

test("suppressions are counted by kind and File class in Source and Test code only", async () => {
  const res = await runNativeCheck("quality.suppressions", suppressionsProject);
  const want = new Map<string, number>([
    ["eslint-disable in source", 4], // block, next-line, line, and packages/lib
    ["biome-ignore in source", 1],
    ["@ts-ignore in source", 1],
    ["@ts-expect-error in source", 1],
    ["@ts-nocheck in source", 1],
    ["c8 ignore in source", 1], // "c8 ignore stop" is no Suppression
    ["istanbul ignore in source", 1],
    ["node:coverage ignore in source", 1],
    ["gitleaks:allow in source", 1],
    ["hadolint ignore in source", 1],
    ["shellcheck disable in source", 1],
    ["jscpd:ignore-start in source", 1],
    ["stryker disable in source", 1],
    ["eslint-disable in test_code", 1],
    ["@ts-ignore in test_code", 2],
    ["c8 ignore in test_code", 1],
  ]);
  // Test data, Build output and prose must not be counted.
  assert.deepEqual(suppressionCounts(inventoryOf(res)), want);
});

test("suppressions say that config file suppressions are not counted", async () => {
  const res = await runNativeCheck("quality.suppressions", suppressionsProject);
  assert.ok(
    res.limitations?.some(
      (l) =>
        l.reason_code === "config_suppressions_not_counted" &&
        l.check_id === "quality.suppressions",
    ),
    JSON.stringify(res.limitations),
  );
});

test("the Inventory holds hashes of Test code, config files, manifests and lockfiles", async () => {
  const res = await runNativeCheck("quality.suppressions", suppressionsProject);
  const want = new Map<string, [string, string]>([
    [
      "package.json",
      [
        "manifest",
        "8128120a0094d54561c0b233bd2e5a704c11144162333a2de88574d53dc4e6af",
      ],
    ],
    [
      "package-lock.json",
      [
        "lockfile",
        "e797d1a339d20beb93ad695d073070ea79226da2cd9d6122d1fcb04645e60ad5",
      ],
    ],
    [
      "packages/lib/package.json",
      [
        "manifest",
        "dc64347675b4e75a927b0cb094e43a40d29b880e9b72f8cdf6bd2840cd2bb9cc",
      ],
    ],
    [
      "packages/lib/package-lock.json",
      [
        "lockfile",
        "33c3cbb9fe96c0783e72822561271451fac93c1b1419638bc7e05df3a30b790d",
      ],
    ],
    [
      ".mocharc.json",
      [
        "test_config",
        "e56e400afcfbe193d91051a8eadc8331c7f02f439aa38af15898383822e7a76c",
      ],
    ],
    [
      "eslint.config.js",
      [
        "lint_config",
        "4707cce5979ba8f9408b54b0f076b033f630f1d29476e110730be212556a9cae",
      ],
    ],
    [
      "biome.json",
      [
        "lint_config",
        "231ea1c84b742103565a4b41810eda5110e51bbf9011f9d2ce898cff8dc0c2ec",
      ],
    ],
    [
      ".c8rc.json",
      [
        "coverage_config",
        "31e4afb363d312a2e8cdac03802f481a59177c1d67d260ef51de5ae095c7494d",
      ],
    ],
    [
      "tsconfig.json",
      [
        "typescript_config",
        "830deba0a94e3d5dced6e7f8967d8782136ec80d910b2660767f80917521fcb7",
      ],
    ],
    [
      "test/app.test.js",
      [
        "test_code",
        "4db68dbad53e008b40e4b223342a228a18647f8f4b72e48487fb8027b212840f",
      ],
    ],
  ]);
  const hashes = inventoryOf(res).file_hashes;
  // Test data and Build output files get none.
  assert.deepEqual(
    new Map(hashes.map((h) => [h.path, [h.role, h.sha256]])),
    want,
  );
  const order = hashes.map((h) => h.path);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    "hashes are sorted by path",
  );
});

test("suppressions ignore directives that are not in comments", async (t) => {
  const root = project(t, {
    "src/a.js":
      "const s = 'eslint-disable';\n" +
      'const t = "@ts-ignore";\n' +
      "// prose that mentions eslint-disable mid-sentence\n" +
      "//eslint-disable-next-line no-undef\n" +
      "/**\n * @ts-expect-error\n */\n" +
      "<!-- eslint-disable -->\n",
  });
  const res = await runNativeCheck("quality.suppressions", root);
  const got = suppressionCounts(inventoryOf(res));
  assert.equal(got.get("eslint-disable in source"), 2);
  assert.equal(got.get("@ts-expect-error in source"), 1);
  assert.equal(got.get("@ts-ignore in source"), undefined);
});

test("suppressions apply to projects without any JavaScript", (t) => {
  const root = project(t, { "README.md": "hello\n" });
  const proj = discover(root);
  for (const id of ["quality.size", "quality.suppressions"]) {
    assert.equal(
      impl(id).applicability(proj, projectContext(proj))[0],
      Applicable,
      id,
    );
  }
});

test("njsscan-ignore and nosemgrep comments are suppressions", async (t) => {
  const root = project(t, {
    "package.json": '{"name":"p"}',
    "src/app.js":
      "// njsscan-ignore: express_open_redirect\n" +
      "res.redirect(req.query.next);\n" +
      "// nosemgrep: prueffactory.eval-non-literal\n" +
      "eval(x); // nosemgrep\n" +
      "const s = 'a nosemgrep in a string is not a comment';\n",
    "test/app.test.js": "// nosemgrep\nexec(cmd);\n",
  });

  const got = suppressionCounts(
    inventoryOf(await runNativeCheck("quality.suppressions", root)),
  );

  assert.deepEqual(
    got,
    new Map([
      ["njsscan-ignore in source", 1],
      ["nosemgrep in source", 2],
      ["nosemgrep in test_code", 1],
    ]),
  );
});

test("suppression comments match as RE2 does: its white space, its case folding and in linear time", async (t) => {
  const root = project(t, {
    // \v and U+00A0 are no white space for RE2's \s; Kelvin sign and long s fold in (?i:).
    "src/a.js":
      "// c8\x0bignore next\n" +
      "// c8 ignore next\n" +
      "// c8 ignore next\n" +
      "// ſtryker disable\n" +
      "// stryKer disable\n" +
      "//* eslint-disable\n" +
      "x /*// eslint-disable\n",
    // A hostile line must not cost quadratic time.
    "src/b.js": "/".repeat(200_000) + "\n" + "#".repeat(200_000) + "\n",
  });

  const started = Date.now();
  const got = suppressionCounts(
    inventoryOf(await runNativeCheck("quality.suppressions", root)),
  );

  assert.ok(Date.now() - started < 5000, "a line of slashes took too long");
  assert.deepEqual(
    got,
    new Map([
      ["c8 ignore in source", 1],
      ["stryker disable in source", 2],
      ["eslint-disable in source", 2],
    ]),
  );
});
