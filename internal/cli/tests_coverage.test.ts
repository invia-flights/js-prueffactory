// Seam A without Docker: what list-checks says about tests.coverage. It
// measures the run of tests.existing, so it applies where that run applies
// and is unsupported where that run is.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  applicabilityAt,
  listChecksJSON,
  projectWith,
  rowOf,
} from "./listchecks.testutil.ts";

async function testsCoverageRow(
  t: TestContext,
  files: Record<string, string>,
): Promise<[string, string]> {
  const l = await listChecksJSON(t, projectWith(t, files), "--format", "json");
  const row = rowOf(l, "tests.coverage");
  assert.equal(row.applicability.length, 1, JSON.stringify(row.applicability));
  return applicabilityAt(l, "tests.coverage", "package");
}

test("tests.coverage is implemented, selected and never fires Gates", async (t) => {
  const l = await listChecksJSON(
    t,
    projectWith(t, { "package.json": '{"name":"demo"}' }),
    "--format",
    "json",
  );
  const row = rowOf(l, "tests.coverage");
  assert.equal(row.status, "implemented");
  assert.equal(row.selected, true);
  assert.equal(row.can_fire_gates, false);
  assert.equal(row.benchmark_area, "side_indicator");
});

test("tests.coverage applies to a package with tests that can run", async (t) => {
  const [got, reason] = await testsCoverageRow(t, {
    "package.json": '{"name":"demo","scripts":{"test":"c8 mocha"}}',
    "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
  });
  assert.equal(got, "unknown");
  assert.ok(
    reason.includes("Mocha version"),
    `${reason}: unknown, because the Mocha version is known only after the install`,
  );
});

test("tests.coverage is unsupported where the runner is and not applicable without tests", async (t) => {
  let [got, reason] = await testsCoverageRow(t, {
    "package.json": '{"scripts":{"test":"jest --ci"}}',
    "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
  });
  assert.equal(got, "applicable");
  assert.ok(reason.startsWith("unsupported: "), reason);
  assert.ok(reason.includes("Jest"), reason);

  [got, reason] = await testsCoverageRow(t, {
    "package.json": '{"name":"demo","scripts":{"start":"node ."}}',
  });
  assert.equal(got, "not_applicable");
  assert.ok(reason.includes("no test script"), reason);
});
