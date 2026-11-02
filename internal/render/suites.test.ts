import assert from "node:assert/strict";
import { test } from "node:test";

import type { PackageTests, SuiteTests } from "../resultset/types.ts";
import { handMade, md, section } from "./render.testutil.ts";

function counts(found: number, passed: number, failed: number) {
  return {
    found,
    run: passed + failed,
    passed,
    failed,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
  };
}

function handMadeTests(
  ctx: string,
  found: number,
  passed: number,
  failed: number,
): PackageTests {
  return { context_id: ctx, ...counts(found, passed, failed) };
}

function handMadeSuite(
  ctx: string,
  suite: string,
  found: number,
  passed: number,
  failed: number,
): SuiteTests {
  return { context_id: ctx, suite, ...counts(found, passed, failed) };
}

// A Report of a package that runs several suites says which suite a test
// Finding came from and shows the counts per suite.

// Go: TestMarkdownNamesTheSuiteOfAFindingAndShowsCountsPerSuite.
test("a Finding names its suite and the counts are shown per suite", () => {
  const s = handMade();
  const f = s.findings[0];
  assert.ok(f);
  f.suite = "test:api";
  s.inventory.tests.push(handMadeTests("C-0002", 5, 4, 1));
  s.inventory.test_suites.push(
    handMadeSuite("C-0002", "test:unit", 3, 3, 0),
    handMadeSuite("C-0002", "test:api", 2, 1, 1),
  );
  const out = md(s);
  assert.ok(section(out, "## Gates").includes("Suite: `test:api`"));
  const inv = section(out, "## Inventory");
  for (const want of [
    "| Context | Suite | Found |",
    "| C-0002 | `test:unit` | 3 |",
    "| C-0002 | `test:api` | 2 |",
  ]) {
    assert.ok(inv.includes(want), `inventory misses ${want}:\n${inv}`);
  }
});

// Go: TestMarkdownLeavesOutThePerSuiteTableForPackagesWithOneSuite.
test("packages with one suite get no per-suite table", () => {
  const s = handMade();
  s.inventory.tests.push(handMadeTests("C-0002", 5, 4, 1));
  s.inventory.test_suites.push(
    handMadeSuite("C-0002", "scripts.test", 5, 4, 1),
  );
  assert.ok(!section(md(s), "## Inventory").includes("| Suite |"));
});
