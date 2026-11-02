import assert from "node:assert/strict";
import { test } from "node:test";

import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import { PartMeasured, PartNotApplicable } from "../resultset/types.ts";
import { newContext } from "../resultset/zero.ts";
import {
  area,
  part,
  score,
  wantNull,
  wantScore,
} from "./benchmark.testutil.ts";

// Seam B: what the Benchmark makes of a lint.existing that is not applicable
// to a package, such as one with ESLint as a dependency and no configuration.

// Go: TestAProjectLinterThatDoesNotApplyToOnePackageIsMeasuredFromThePackagesWhereItDoes.
test("a project linter that does not apply to one package is measured from the packages where it does", () => {
  // One package has ESLint without any configuration, so lint.existing is
  // not applicable there; a second package has Biome, which runs with
  // defaults.
  const p = scoredProject();
  p.set.contexts.push(
    newContext({ id: "C-0003", kind: "package", path: "packages/biome" }),
  );
  p.addExecution("lint.existing", "C-0003");
  p.add("lint.existing", "lint/suspicious/noDebugger", true, (f) => {
    f.execution_id = "added-lint.existing";
    f.context_id = "C-0003";
  });

  const got = part(score(p).benchmark, "project_linter");

  assert.equal(got.state, PartMeasured, `reason ${String(got.reason)}`);
  wantScore("raw value", got.raw_value, 1);
});

// Go: TestAProjectLinterThatAppliesToNoPackageIsNotApplicableAndKeepsTheAreasOtherParts.
test("a project linter that applies to no package is not applicable and keeps the area's other parts", () => {
  const p = scoredProject();
  p.notApplicable("lint.existing");

  const b = score(p).benchmark;

  const got = part(b, "project_linter");
  assert.equal(got.state, PartNotApplicable);
  wantNull("part score", got.score);
  const a = area(b, "code_correctness");
  assert.ok(
    a.exists && a.fully_measured,
    "the area is kept with its other parts",
  );
});
