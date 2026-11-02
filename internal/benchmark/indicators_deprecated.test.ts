import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusBlocked,
} from "../resultset/types.ts";
import { indicator, score, wantScore } from "./benchmark.testutil.ts";

// Go: TestDeprecatedDependenciesShowAsSideIndicatorsPerScopeAndNeverChangeTheScore.
test("deprecated dependencies show as side indicators per scope and never change the score", () => {
  const clean = score(scoredProject()).benchmark;

  const p = scoredProject();
  p.addExecution("deps.deprecated", "C-0002");
  for (let i = 0; i < 7; i++) {
    p.add("deps.deprecated", "deprecated-version", false);
  }
  p.metric("deps.deprecated", "deprecated_prod", 5, "versions");
  p.metric("deps.deprecated", "deprecated_dev", 2, "versions");
  p.metric("deps.deprecated", "registry_unknown", 30, "packages");
  const b = score(p).benchmark;

  const prod = indicator(b, "deprecated_prod");
  wantScore("deprecated prod", prod.value, 5);
  assert.equal(prod.state, PartMeasured);
  assert.equal(prod.unit, "versions");
  assert.deepEqual(prod.source_checks, ["deps.deprecated"]);
  wantScore("deprecated dev", indicator(b, "deprecated_dev").value, 2);
  assert.equal(b.score, clean.score);
  assert.deepEqual(b.range, clean.range);
  assert.equal(b.verdict, clean.verdict);
  for (const a of b.areas) {
    for (const pt of a.parts) {
      assert.ok(
        !pt.source_checks.includes("deps.deprecated"),
        `part ${pt.id} is fed by deps.deprecated, which is a side indicator only`,
      );
    }
  }
});

// Go: TestDeprecatedDependenciesAreUnknownNeverZeroWhenTheRegistryCouldNotBeReached.
test("deprecated dependencies are unknown, never zero, when the registry could not be reached", () => {
  const clean = score(scoredProject()).benchmark;

  const p = scoredProject();
  p.addExecution("deps.deprecated", "C-0002");
  p.status("deps.deprecated", StatusBlocked, "registry_unreachable");
  const b = score(p).benchmark;

  for (const id of ["deprecated_prod", "deprecated_dev"]) {
    const got = indicator(b, id);
    assert.equal(got.state, PartUnknown, id);
    assert.equal(got.value, null, id);
    assert.ok(got.reason?.includes("registry_unreachable"), id);
  }
  assert.equal(b.score, clean.score);
  assert.equal(b.verdict, clean.verdict);
});

// Go: TestDeprecatedIndicatorsAreUnknownWhenTheCheckDidNotTakePart.
test("deprecated indicators are unknown when the Check did not take part", () => {
  const b = score(scoredProject()).benchmark;
  for (const id of ["deprecated_prod", "deprecated_dev"]) {
    const got = indicator(b, id);
    assert.equal(got.state, PartUnknown, id);
    assert.equal(got.value, null, id);
  }
});
