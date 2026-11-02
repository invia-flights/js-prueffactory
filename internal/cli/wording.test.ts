// Seam A without Docker: a reason says what js-prueffactory supports, never in
// which milestone. Readers of a Report don't know the milestones, and a reason
// that names one turns false when the next one starts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { catalog, CatalogVersion, Planned } from "../checks/catalog.ts";
import { call, noDocker, project, useCatalogFor } from "./cli.testutil.ts";
import {
  listChecksJSON,
  noDockerEnv,
  projectWith,
  rowOf,
} from "./listchecks.testutil.ts";

// assertNamesNoMilestone fails when text names a milestone. The Catalog
// version is an identifier that list-checks and the Report show, not a
// reason, so it is left out.
function assertNamesNoMilestone(where: string, text: string): void {
  const t = text.replaceAll(CatalogVersion, "");
  const i = t.toLowerCase().indexOf("milestone");
  assert.ok(
    i < 0,
    `${where} names a milestone: …${t.slice(Math.max(0, i - 80), i + 80)}…`,
  );
}

const plannedCheck = "api.dast";

describe("reasons say what the tool supports and name no milestone", () => {
  const lock = '{"lockfileVersion":3,"packages":{}}';
  // check is the Check whose reason is read, or "" for the Node version of
  // the package Context; want is text the reason holds.
  const cases: [string, Record<string, string>, string, string][] = [
    [
      "yarn lockfile",
      { "package.json": '{"name":"demo"}', "yarn.lock": "# yarn\n" },
      "package.install",
      "the package uses yarn (yarn.lock), and js-prueffactory supports only npm",
    ],
    [
      "workspaces field",
      {
        "package.json": '{"name":"demo","workspaces":["packages/*"]}',
        "package-lock.json": lock,
      },
      "package.install",
      "the package.json has a workspaces field, and js-prueffactory does not support npm workspaces",
    ],
    [
      "jest test script",
      {
        "package.json": '{"scripts":{"test":"jest --ci"}}',
        "package-lock.json": lock,
      },
      "tests.existing",
      "js-prueffactory runs only `mocha …` and `node … --test …`",
    ],
    [
      "node version file",
      { "package.json": '{"name":"demo"}', ".nvmrc": "18\n" },
      "",
      "Node 18, declared in .nvmrc, is not supported: js-prueffactory runs Node ",
    ],
    [
      "engines.node",
      { "package.json": '{"name":"demo","engines":{"node":"<18"}}' },
      "",
      "is satisfied by none of the supported Node majors: js-prueffactory runs Node ",
    ],
  ];
  for (const [name, files, check, want] of cases) {
    test(name, async (t) => {
      const dir = projectWith(t, files);
      const l = await listChecksJSON(t, dir, "--format", "json");
      const reason =
        check === ""
          ? (l.contexts.at(-1)?.node_unsupported ?? "")
          : (rowOf(l, check).applicability[0]?.reason ?? "");
      assert.ok(reason.includes(want), reason);
      for (const format of ["json", "markdown"]) {
        const r = await call(
          noDockerEnv(t),
          "list-checks",
          dir,
          "--format",
          format,
        );
        assert.equal(r.code, 0, r.stderr);
        assertNamesNoMilestone(`list-checks --format ${format}`, r.stdout);
      }
    });
  }
});

test("a workspace member is unsupported for what the tool supports", async (t) => {
  const dir = projectWith(t, {
    "package.json": '{"name":"root","workspaces":["packages/*"]}',
    "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
    "packages/a/package.json": '{"name":"a"}',
  });
  const l = await listChecksJSON(t, dir, "--format", "json");
  const a = rowOf(l, "package.install").applicability.find(
    (x) => x.path === "packages/a",
  );
  assert.ok(a, "the workspace member is not listed");
  assert.ok(
    a.reason.includes("and js-prueffactory does not support npm workspaces"),
    a.reason,
  );
  assertNamesNoMilestone("the workspace member's reason", a.reason);
});

test("selecting a planned Check is refused without naming a milestone", async (t) => {
  useCatalogFor(
    t,
    catalog().map((e) =>
      e.id === plannedCheck ? { ...e, status: Planned } : e,
    ),
  );
  const r = await call(
    noDocker(t),
    "list-checks",
    project(t),
    "--only",
    plannedCheck,
  );
  assert.equal(r.code, 3);
  assert.ok(r.stderr.includes("planned"), r.stderr);
  assertNamesNoMilestone("the error", r.stderr);
});

// The texts a seam test reaches only through Docker: no string literal in the
// tool's non-test TypeScript code names a milestone. Comments may, because
// they explain history.
test("no text in the tool's source names a milestone", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  for (const root of ["internal", "cmd", "bin"]) {
    for (const file of sourceFiles(join(repo, root))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        false,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          node.text !== CatalogVersion
        ) {
          assertNamesNoMilestone(file, node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "testdata" && entry.name !== "node_modules") {
        out.push(...sourceFiles(p));
      }
    } else if (
      /\.(ts|js)$/.test(entry.name) &&
      !/\.(test|testutil)\.ts$/.test(entry.name)
    ) {
      out.push(p);
    }
  }
  return out;
}
