// The Catalog entries, images, prerequisites and Applicability of the
// Checks that read the lockfile's registry data (Go:
// deps_deprecated_meta_test.go, deps_outdated_meta_test.go and
// sbom_generate_meta_test.go).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import "./all.ts";
import {
  AreaNone,
  AreaSideIndicator,
  Implemented,
  lookup,
  PerPackage,
} from "./catalog.ts";
import { impl } from "./checks.testutil.ts";
import { firstPackage } from "./registry_meta.testutil.ts";

for (const [id, area] of [
  ["deps.deprecated", AreaSideIndicator],
  ["deps.outdated", AreaSideIndicator],
  ["sbom.generate", AreaNone],
] as const) {
  describe(id, () => {
    test("is an implemented per-package Check that fires no Gates, in its area", () => {
      // Go: TestDepsDeprecatedIsAnImplementedSideIndicatorWithoutGates,
      // TestDepsOutdatedIsAnImplementedSideIndicatorWithoutGates,
      // TestSBOMGenerateIsAnImplementedPerPackageCheckWithoutGatesOrBenchmarkArea
      const e = lookup(id);
      assert.ok(e);
      assert.equal(e.status, Implemented);
      assert.equal(e.scope, PerPackage);
      assert.equal(e.canFireGates, false);
      assert.equal(e.area, area);
    });

    test("runs in the Node image of a package with a lockfile and needs no install", () => {
      // Go: TestDepsDeprecatedRunsInTheNodeImageOfAPackageWithALockfileAndNeedsNoInstall,
      // TestDepsOutdatedSharesTheRegistryStepOfDepsDeprecated,
      // TestSBOMGenerateRunsInTheNodeImageAndInstallsOnlyWithoutALockfile
      const [, c] = firstPackage("vulnerable-dependency");
      const check = impl(id);
      assert.ok(c.node);
      assert.deepEqual(check.images?.(c), [c.node.image]);
      assert.deepEqual(check.prerequisites?.(c), []);
      assert.deepEqual(check.applicability(null as never, c), [
        "applicable",
        "",
      ]);
    });

    test("reads the lockfile the install produced when the package has none", () => {
      // Go: TestDepsDeprecatedReadsTheLockfileTheInstallProducedWhenThePackageHasNone
      const [, c] = firstPackage("no-lockfile");
      assert.deepEqual(impl(id).prerequisites?.(c), ["package.install"]);
    });

    test("has nothing to examine in the project Context", () => {
      // Go: Test…HasNothingToExamineInTheProjectContext
      const [proj] = firstPackage("vulnerable-dependency");
      const project = proj.contexts[0];
      assert.ok(project);
      const [a, reason] = impl(id).applicability(proj, project);
      assert.equal(a, "not_applicable");
      assert.notEqual(reason, "");
    });
  });
}

test("deps.tree needs the install, the Working copy and the package's Node image", () => {
  // Beyond Go's tests (Go checks these through the engine and Docker
  // tests): the interfaces the engine reads.
  const [proj, c] = firstPackage("vulnerable-dependency");
  const check = impl("deps.tree");
  assert.ok(c.node);
  assert.deepEqual(check.prerequisites?.(c), ["package.install"]);
  assert.equal(check.usesWorkingCopy?.(), true);
  assert.deepEqual(check.images?.(c), [c.node.image]);
  const project = proj.contexts[0];
  assert.ok(project);
  assert.equal(check.applicability(proj, project)[0], "not_applicable");
});
