// Seam A without Docker: what list-checks says about the per-package Checks
// whose Applicability depends on the manifest, the lockfile and the files of
// a package (Go: lint_existing_list_test.go, lockfile_checks_list_test.go,
// types_javascript_list_test.go, schema_drift_list_test.go,
// package_install_test.go).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { project } from "./cli.testutil.ts";
import {
  applicabilityAt,
  listChecksJSON,
  projectWith,
  rowOf,
  testdataProject,
} from "./listchecks.testutil.ts";

const lock = '{"lockfileVersion":3,"packages":{}}';

describe("lint.existing", () => {
  test("does not apply to ESLint without any configuration", async (t) => {
    const l = await listChecksJSON(
      t,
      testdataProject("eslint-no-config"),
      "--format",
      "json",
    );
    const [got, reason] = applicabilityAt(l, "lint.existing", "package");
    assert.equal(got, "not_applicable");
    assert.ok(reason.includes("ESLint is a dependency"), reason);
    assert.ok(reason.includes("no ESLint configuration"), reason);
  });
  for (const name of ["eslint-legacy", "project-eslint"]) {
    test(`applies to a configured ESLint: ${name}`, async (t) => {
      const l = await listChecksJSON(
        t,
        testdataProject(name),
        "--format",
        "json",
      );
      assert.equal(
        applicabilityAt(l, "lint.existing", "package")[0],
        "applicable",
      );
    });
  }
});

describe("the lockfile Checks", () => {
  const ids = [
    "security.integrity",
    "security.licenses",
    "package.install-scripts",
  ];

  test("apply to a yarn package", async (t) => {
    const l = await listChecksJSON(
      t,
      testdataProject("yarn-unsupported"),
      "--format",
      "json",
    );
    for (const id of ids) {
      assert.equal(applicabilityAt(l, id, "package")[0], "applicable", id);
    }
  });

  const others: [string, Record<string, string>][] = [
    [
      "pnpm lockfile",
      {
        "package.json": '{"name":"demo"}',
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
      },
    ],
    [
      "bun text lockfile",
      { "package.json": '{"name":"demo"}', "bun.lock": "{}\n" },
    ],
    [
      "bun binary lockfile",
      { "package.json": '{"name":"demo"}', "bun.lockb": "x" },
    ],
    [
      "packageManager field",
      { "package.json": '{"name":"demo","packageManager":"pnpm@9.1.0"}' },
    ],
  ];
  for (const [name, files] of others) {
    test(`apply, unsupported, to every other package manager: ${name}`, async (t) => {
      const l = await listChecksJSON(
        t,
        projectWith(t, files),
        "--format",
        "json",
      );
      for (const id of ids) {
        const [got, reason] = applicabilityAt(l, id, "package");
        assert.equal(got, "applicable", id);
        assert.ok(reason.includes("unsupported"), `${id}: ${reason}`);
      }
    });
  }

  test("do not apply when the packageManager field names npm and there is no lockfile", async (t) => {
    const l = await listChecksJSON(
      t,
      projectWith(t, {
        "package.json": '{"name":"demo","packageManager":"npm@10.8.0"}',
      }),
      "--format",
      "json",
    );
    for (const id of ids) {
      assert.equal(applicabilityAt(l, id, "package")[0], "not_applicable", id);
    }
  });

  test("do not apply without any lockfile", async (t) => {
    const l = await listChecksJSON(
      t,
      testdataProject("no-lockfile"),
      "--format",
      "json",
    );
    for (const id of ids) {
      const [got, reason] = applicabilityAt(l, id, "package");
      assert.equal(got, "not_applicable", id);
      assert.ok(reason.endsWith("this package has no lockfile"), reason);
    }
  });
});

describe("types.javascript", () => {
  for (const name of ["types-mixed-ts", "types-tsx", "typescript-source"]) {
    test(`applies to packages with TypeScript files: ${name}`, async (t) => {
      const l = await listChecksJSON(
        t,
        testdataProject(name),
        "--format",
        "json",
      );
      assert.deepEqual(applicabilityAt(l, "types.javascript", "package"), [
        "applicable",
        "",
      ]);
    });
  }
  test("is unsupported for TypeScript that needs a build step", async (t) => {
    const l = await listChecksJSON(
      t,
      testdataProject("typescript-build-step"),
      "--format",
      "json",
    );
    const [got, reason] = applicabilityAt(l, "types.javascript", "package");
    assert.equal(got, "applicable");
    assert.ok(reason.startsWith("unsupported: "), reason);
    for (const want of ["build step", "outDir", "src/index.ts"]) {
      assert.ok(reason.includes(want), `${reason} lacks ${want}`);
    }
  });
});

describe("schema.drift", () => {
  test("applies to every package with a generator script", async (t) => {
    const l = await listChecksJSON(
      t,
      testdataProject("schema-drift"),
      "--format",
      "json",
    );
    assert.equal(rowOf(l, "schema.drift").status, "implemented");
    for (const path of [".", "tools/legacy"]) {
      assert.deepEqual(applicabilityAt(l, "schema.drift", "package", path), [
        "applicable",
        "",
      ]);
    }
  });

  const without: [string, string][] = [
    ["no scripts", ""],
    [
      "a name that does not point to generation",
      '"lint": "node scripts/lint.js"',
    ],
    [
      "a lifecycle name",
      '"build": "node scripts/generate-schema.js", "postinstall": "node scripts/schema.js"',
    ],
    ["a command chain", '"gen:schema": "node a.js && node b.js"'],
    [
      "a command that is not node",
      '"gen:schema": "ts-node scripts/gen.ts", "generate": "sh gen.sh"',
    ],
    [
      "a node option before the file",
      '"gen:schema": "node --require ./hook.js gen.js"',
    ],
  ];
  for (const [name, scripts] of without) {
    test(`does not apply without a generator script: ${name}`, async (t) => {
      const dir = project(t);
      writeFileSync(
        join(dir, "package.json"),
        `{"name":"demo","scripts":{${scripts}}}`,
      );
      const l = await listChecksJSON(t, dir, "--format", "json");
      const [got, reason] = applicabilityAt(l, "schema.drift", "package");
      assert.equal(got, "not_applicable");
      assert.ok(reason.includes("no_generator_script"), reason);
    });
  }

  test("applies to a plain node generator script", async (t) => {
    const dir = project(t);
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"demo","scripts":{"swagger2schema":"API_HOST=localhost node ./tools/swagger2schema.js --out schemas"}}',
    );
    const l = await listChecksJSON(t, dir, "--format", "json");
    assert.equal(
      applicabilityAt(l, "schema.drift", "package")[0],
      "applicable",
    );
  });
});

describe("package.install and deps.tree", () => {
  test("are implemented and selected", async (t) => {
    const l = await listChecksJSON(
      t,
      projectWith(t, { "package.json": '{"name":"demo"}' }),
      "--format",
      "json",
    );
    for (const id of ["package.install", "deps.tree"]) {
      const row = rowOf(l, id);
      assert.equal(row.status, "implemented", id);
      assert.equal(row.selected, true, id);
    }
    assert.equal(rowOf(l, "package.install").can_fire_gates, true);
  });

  const unsupported: [string, Record<string, string>, string][] = [
    [
      "pnpm lockfile",
      {
        "package.json": '{"name":"demo"}',
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
      },
      "pnpm-lock.yaml",
    ],
    [
      "yarn lockfile",
      { "package.json": '{"name":"demo"}', "yarn.lock": "# yarn\n" },
      "yarn.lock",
    ],
    [
      "bun lockfile",
      { "package.json": '{"name":"demo"}', "bun.lockb": "x" },
      "bun.lockb",
    ],
    [
      "deno config",
      { "package.json": '{"name":"demo"}', "deno.json": "{}" },
      "deno.json",
    ],
    [
      "packageManager field",
      { "package.json": '{"name":"demo","packageManager":"yarn@4.1.0"}' },
      "packageManager",
    ],
    [
      "workspace root",
      {
        "package.json": '{"name":"demo","workspaces":["packages/*"]}',
        "package-lock.json": lock,
      },
      "workspaces",
    ],
  ];
  for (const [name, files, want] of unsupported) {
    test(`name why a package cannot be installed: ${name}`, async (t) => {
      const l = await listChecksJSON(
        t,
        projectWith(t, files),
        "--format",
        "json",
      );
      for (const id of ["package.install", "deps.tree"]) {
        const a = rowOf(l, id).applicability;
        assert.equal(a.length, 1, id);
        assert.equal(a[0]?.applicability, "applicable", id);
        assert.ok(a[0].reason.includes("unsupported"), a[0].reason);
        assert.ok(a[0].reason.includes(want), a[0].reason);
      }
    });
  }

  test("mark workspace members unsupported too", async (t) => {
    const l = await listChecksJSON(
      t,
      projectWith(t, {
        "package.json": '{"name":"root","workspaces":["packages/*"]}',
        "package-lock.json": lock,
        "packages/a/package.json": '{"name":"a"}',
        "packages/a/index.js": "module.exports = 1;\n",
        "tools/standalone/package.json": '{"name":"standalone"}',
      }),
      "--format",
      "json",
    );
    const byPath = new Map(
      rowOf(l, "package.install").applicability.map((a) => [a.path, a.reason]),
    );
    assert.ok(byPath.get("packages/a")?.includes("workspace"));
    assert.equal(byPath.get("tools/standalone"), "");
  });

  const installable: [string, Record<string, string>][] = [
    [
      "npm lockfile",
      { "package.json": '{"name":"demo"}', "package-lock.json": lock },
    ],
    [
      "shrinkwrap",
      { "package.json": '{"name":"demo"}', "npm-shrinkwrap.json": lock },
    ],
    ["no lockfile", { "package.json": '{"name":"demo"}' }],
  ];
  for (const [name, files] of installable) {
    test(`show no reason for an installable package: ${name}`, async (t) => {
      const l = await listChecksJSON(
        t,
        projectWith(t, files),
        "--format",
        "json",
      );
      const a = rowOf(l, "package.install").applicability[0];
      assert.equal(a?.applicability, "applicable");
      assert.equal(a.reason, "");
    });
  }
});
