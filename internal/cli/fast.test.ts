// Seam A tests without Docker for the --fast flag.
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
import { listChecksJSON, noDockerEnv, rowOf } from "./listchecks.testutil.ts";

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

test("list-checks shows which Checks --fast skips", async (t) => {
  const dir = project(t);
  const l = await listChecksJSON(t, dir, "--format", "json");
  assert.deepEqual(
    l.checks.filter((c) => c.skipped_by_fast).map((c) => c.id),
    ["tests.mutation", "api.fuzz", "api.dast"],
  );
  assert.equal(l.fast, false);

  const r = await call(noDockerEnv(t), "list-checks", dir);
  const lines = r.stdout.split("\n");
  const header = lines.find((line) => line.startsWith("| Check")) ?? "";
  assert.ok(header.includes("Skipped by `--fast`"), header);
  const column = header.split("|").findIndex((h) => h.includes("Skipped by"));
  const rows = new Map<string, string>();
  for (const line of lines) {
    const cells = line.split("|");
    if (line.startsWith("| `") && cells.length > 2) {
      rows.set((cells[1] ?? "").trim().replaceAll("`", ""), line);
    }
  }
  for (const c of l.checks) {
    const cell = (rows.get(c.id) ?? "").split("|")[column]?.trim();
    assert.equal(cell, c.skipped_by_fast ? "yes" : "no", c.id);
  }
});

test("list-checks --fast with every marked Check planned keeps the Selection", async (t) => {
  useCatalogFor(
    t,
    catalog().map((e) => (e.skippedByFast ? { ...e, status: Planned } : e)),
  );
  const dir = project(t);
  const l = await listChecksJSON(t, dir, "--format", "json", "--fast");
  assert.equal(l.fast, true);
  const plain = await listChecksJSON(t, dir, "--format", "json");
  assert.deepEqual(
    l.checks.map((c) => c.selected),
    plain.checks.map((c) => c.selected),
  );
});

test("list-checks --fast shows the resulting Selection", async (t) => {
  fastCatalog(t);
  const dir = project(t);
  const plain = await listChecksJSON(t, dir, "--format", "json");
  for (const id of ["tests.mutation", "api.fuzz"]) {
    assert.equal(rowOf(plain, id).selected, true, id);
  }
  const l = await listChecksJSON(t, dir, "--format", "json", "--fast");
  for (const id of ["tests.mutation", "api.fuzz", "api.dast"]) {
    const row = rowOf(l, id);
    assert.equal(row.selected, false, id);
    assert.equal(row.skipped_by_fast, true, id);
  }
  assert.equal(rowOf(l, "syntax.parse").selected, true);
});

test("--fast removes skipped Checks after --only and --exclude", async (t) => {
  fastCatalog(t);
  const dir = project(t);
  let l = await listChecksJSON(
    t,
    dir,
    "--format",
    "json",
    "--fast",
    "--only",
    "tests.mutation,syntax.parse",
  );
  for (const c of l.checks) {
    assert.equal(c.selected, c.id === "syntax.parse", c.id);
  }
  l = await listChecksJSON(
    t,
    dir,
    "--format",
    "json",
    "--fast",
    "--exclude",
    "syntax",
  );
  assert.equal(rowOf(l, "syntax.parse").selected, false);
  assert.equal(rowOf(l, "tests.mutation").selected, false);
  assert.equal(rowOf(l, "package.manifest").selected, true);
});

test("without --fast the Checks --fast skips can be selected", async (t) => {
  fastCatalog(t);
  const r = await call(
    noDockerEnv(t),
    "list-checks",
    project(t),
    "--only",
    "tests.mutation,api.fuzz",
  );
  assert.equal(r.code, 0, r.stderr);
});

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
