// Seam A without Docker: a reason says what js-prueffactory supports, never in
// which milestone. Readers of a Report don't know the milestones, and a reason
// that names one turns false when the next one starts. The reasons that
// list-checks prints need Discovery and are tested with list-checks.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { catalog, CatalogVersion, Planned } from "../checks/catalog.ts";
import { call, noDocker, project, useCatalogFor } from "./cli.testutil.ts";

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
