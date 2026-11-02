// Seam A tests without Docker for the --fast flag. The parts of the Go tests
// that read list-checks output need Discovery and come with list-checks.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import { catalog, Implemented, Planned } from "../checks/catalog.ts";
import {
  call,
  noDocker,
  project,
  tempDir,
  useCatalogFor,
} from "./cli.testutil.ts";

// fastCatalog is the real Catalog with tests.mutation and api.fuzz
// implemented. api.dast stays planned.
function fastCatalog(t: TestContext): void {
  useCatalogFor(
    t,
    catalog().map((e) =>
      e.id === "tests.mutation" || e.id === "api.fuzz"
        ? { ...e, status: Implemented }
        : e,
    ),
  );
}

describe("--fast works with every command and never trips over a planned marked Check", () => {
  for (const command of ["test", "benchmark"]) {
    test(command, async (t) => {
      // Every Check marked for --fast is planned.
      useCatalogFor(
        t,
        catalog().map((e) => (e.skippedByFast ? { ...e, status: Planned } : e)),
      );
      const r = await call(noDocker(t), command, project(t), "--fast");
      assert.ok(!r.stderr.includes("planned"), r.stderr);
      assert.ok(r.stderr.includes("budget 30m0s (fast_default)"), r.stderr);
    });
  }

  test("naming a planned Check is still an error, with --fast too", async (t) => {
    const r = await call(
      noDocker(t),
      "test",
      project(t),
      "--fast",
      "--only",
      "tests.mutation",
    );
    assert.equal(r.code, 3);
    assert.equal(
      r.stderr,
      'js-prueffactory: --only: "tests.mutation" is planned and not implemented yet, so it cannot be selected\n',
    );
  });
});

describe("--fast that empties the Selection is a usage error", () => {
  for (const command of ["list-checks", "test", "benchmark"]) {
    test(command, async (t) => {
      fastCatalog(t);
      // No docker on PATH: the error must come before the Docker lookup.
      const r = await call(
        { PATH: tempDir(t) },
        command,
        project(t),
        "--fast",
        "--only",
        "tests.mutation,api.fuzz",
      );
      assert.equal(r.code, 3);
      assert.equal(r.stdout, "");
      assert.equal(
        r.stderr,
        "js-prueffactory: the Selection contains no Checks: --only tests.mutation,api.fuzz --fast\n",
      );
    });
  }
});
