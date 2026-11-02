import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartMeasured,
  PartUnknown,
  StatusBlocked,
} from "../resultset/types.ts";
import { indicator, score, wantScore } from "./benchmark.testutil.ts";

// Go: TestOutdatedDependenciesShowAsSideIndicatorsAndNeverChangeTheScore.
test("outdated dependencies show as side indicators and never change the score", () => {
  const clean = score(scoredProject()).benchmark;

  const p = scoredProject();
  p.addExecution("deps.outdated", "C-0002");
  for (let i = 0; i < 4; i++) {
    p.add("deps.outdated", "major-version-behind", false);
  }
  p.metric("deps.outdated", "libyears_total", 41.5, "years");
  p.metric("deps.outdated", "majors_behind", 4, "dependencies");
  p.metric("deps.outdated", "registry_unknown", 2, "packages");
  const b = score(p).benchmark;

  const years = indicator(b, "libyears_total");
  wantScore("libyears", years.value, 41.5);
  assert.equal(years.state, PartMeasured);
  assert.equal(years.unit, "years");
  assert.deepEqual(years.source_checks, ["deps.outdated"]);
  const majors = indicator(b, "majors_behind");
  wantScore("majors behind", majors.value, 4);
  assert.equal(majors.unit, "dependencies");
  assert.equal(b.score, clean.score);
  assert.deepEqual(b.range, clean.range);
  assert.equal(b.verdict, clean.verdict);
  for (const a of b.areas) {
    for (const pt of a.parts) {
      assert.ok(
        !pt.source_checks.includes("deps.outdated"),
        `part ${pt.id} is fed by deps.outdated, which is a side indicator only`,
      );
    }
  }
});

// Go: TestOutdatedIndicatorsAreUnknownNeverZeroWhenTheRegistryCouldNotBeReached.
test("outdated indicators are unknown, never zero, when the registry could not be reached", () => {
  const p = scoredProject();
  p.addExecution("deps.outdated", "C-0002");
  p.status("deps.outdated", StatusBlocked, "registry_unreachable");
  const b = score(p).benchmark;

  for (const id of ["libyears_total", "majors_behind"]) {
    const got = indicator(b, id);
    assert.equal(got.state, PartUnknown, id);
    assert.equal(got.value, null, id);
    assert.ok(got.reason?.includes("registry_unreachable"), id);
  }
});

// Go: TestOutdatedIndicatorsAreUnknownWhenTheCheckDidNotTakePart.
test("outdated indicators are unknown when the Check did not take part", () => {
  const b = score(scoredProject()).benchmark;
  for (const id of ["libyears_total", "majors_behind"]) {
    const got = indicator(b, id);
    assert.equal(got.state, PartUnknown, id);
    assert.equal(got.value, null, id);
  }
});
