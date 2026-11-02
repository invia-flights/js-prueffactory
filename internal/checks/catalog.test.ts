import assert from "node:assert/strict";
import { test } from "node:test";

import "./all.ts";
import {
  AreaSecurity,
  catalog,
  CatalogVersion,
  ExecutionProfile,
  implementedIDs,
  lookup,
  PerPackage,
} from "./catalog.ts";

// The order in which milestone 1 shipped its 29 Checks.
const milestone1 = [
  "package.manifest", "artifacts.structured", "syntax.parse", "security.secrets",
  "security.dependencies", "package.install", "tests.existing", "lint.existing",
  "lint.correctness", "tests.coverage", "tests.smells", "runtime.warnings",
  "types.javascript", "quality.unused", "modules.cycles", "quality.clones",
  "quality.metrics", "quality.size", "quality.suppressions", "security.integrity",
  "security.licenses", "package.install-scripts", "deps.tree", "deps.engines",
  "repository.dockerfile", "repository.shell", "repository.helm", "api.lint",
  "schema.compile",
]; // prettier-ignore

test("the Catalog lists all milestone-one Checks", () => {
  assert.equal(milestone1.length, 29);
  const byID = new Map(catalog().map((e) => [e.id, e]));
  for (const id of milestone1) {
    const e = byID.get(id);
    assert.ok(e, `${id} is missing from the Catalog`);
    assert.equal(
      id.startsWith(e.family + "."),
      true,
      `${id}: family ${e.family}`,
    );
    assert.notEqual(e.area, "", `${id} has no Benchmark area`);
  }
});

test("Catalog IDs are unique and keep their order", () => {
  const ids = catalog().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, milestone1.length), milestone1);
});

test("the shipped profiles are the milestone-two ones", () => {
  assert.equal(CatalogVersion, "milestone-2");
  assert.equal(ExecutionProfile, "execution-v1");
});

test("syntax.parse metadata", () => {
  const e = lookup("syntax.parse");
  assert.ok(e);
  assert.equal(e.canFireGates, true);
  assert.equal(e.area, "validity");
  assert.equal(e.scope, PerPackage);
});

test("security.patterns feeds the security area", () => {
  assert.equal(lookup("security.patterns")?.area, AreaSecurity);
});

test("the status of every Check is the Go build's at the freeze commit", () => {
  // Recorded with `list-checks --format json` of the frozen Go build. The
  // status comes from the registry, which all.ts fills (Go: init functions).
  const planned = ["tests.mutation", "security.containers", "app.lifecycle", "api.fuzz", "api.dast"]; // prettier-ignore
  for (const e of catalog()) {
    assert.equal(
      e.status,
      planned.includes(e.id) ? "planned" : "implemented",
      e.id,
    );
  }
  assert.deepEqual(
    implementedIDs(),
    catalog()
      .filter((e) => !planned.includes(e.id))
      .map((e) => e.id),
  );
  assert.equal(catalog().length, 47);
});
