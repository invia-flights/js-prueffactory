// Helpers shared by the Benchmark scorer's tests, as the Go package
// benchmark_test shared them between its test files.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evidence,
  type FindingMod,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  type Benchmark,
  type BenchmarkArea,
  type BenchmarkFingerprint,
  type BenchmarkPart,
  PartMeasured,
  PartNotApplicable,
  PartProjectFault,
  type Set,
  type SideIndicator,
  type TestFileCount,
  type ToolRef,
} from "../resultset/types.ts";
import { validate } from "../resultset/validate.ts";
import { apply } from "./score.ts";

/**
 * score applies the Benchmark to a finalized set and checks that the set is
 * still consistent, before any other assertion.
 */
export function score(p: Project): Set {
  const s = p.done();
  apply(s);
  assert.deepEqual(validate(s), [], "the scored set is not consistent");
  return s;
}

export function area(b: Benchmark, id: string): BenchmarkArea {
  const a = b.areas.find((x) => x.id === id);
  assert.ok(a, `no area ${id}`);
  return a;
}

export function part(b: Benchmark, id: string): BenchmarkPart {
  for (const a of b.areas) {
    const p = a.parts.find((x) => x.id === id);
    if (p !== undefined) {
      return p;
    }
  }
  assert.fail(`no part ${id}`);
}

export function indicator(b: Benchmark, id: string): SideIndicator {
  const s = b.side_indicators.find((x) => x.id === id);
  assert.ok(
    s,
    `no side indicator ${id} in ${String(b.side_indicators.length)} indicators`,
  );
  return s;
}

/** wantScore asserts a value within 0.05 of want, as the Go tests did. */
export function wantScore(
  name: string,
  got: number | null | undefined,
  want: number,
): void {
  assert.ok(
    got !== null && got !== undefined,
    `${name} is null, want ${String(want)}`,
  );
  assert.ok(
    Math.abs(got - want) <= 0.05,
    `${name} = ${String(got)}, want ${String(want)}`,
  );
}

export function wantNull(name: string, got: number | null): void {
  assert.equal(got, null, `${name} = ${String(got)}, want null`);
}

export function assertProjectFault(got: BenchmarkPart, reason: string): void {
  assert.equal(got.state, PartProjectFault, `part ${got.id} state`);
  assert.equal(got.reason, reason, `part ${got.id} reason`);
  wantScore("score", got.score, 0);
  wantNull("raw value", got.raw_value);
}

export function fingerprintOf(p: Project): BenchmarkFingerprint {
  const fp = score(p).benchmark.fingerprint;
  assert.ok(fp, "no fingerprint");
  return fp;
}

export function advisory(severity: string, scope: string): FindingMod[] {
  return [
    evidence("advisory_severity", severity),
    evidence("dependency_scope", scope),
  ];
}

export function fileCount(
  file: string,
  found: number,
  passed: number,
  focusedPassed: number,
): Partial<TestFileCount> {
  return { file, found, passed, passed_focused: focusedPassed };
}

export function suiteFile(
  suite: string,
  file: string,
  found: number,
  passed: number,
): Partial<TestFileCount> {
  return { suite, file, found, passed };
}

export function inSuite(suite: string): FindingMod {
  return (f) => {
    f.suite = suite;
  };
}

/** PartCase is one row of partTable. */
export interface PartCase {
  name: string;
  build: (p: Project) => void;
  raw: number;
  /** nEff is checked when it is given. */
  nEff?: number;
  want: number;
}

/**
 * partTable runs the cases of a part fed by one Check that has nothing to
 * examine in the clean project: each case makes the Check applicable, builds
 * on it and checks the part's constants, raw value and score. A last test
 * checks that the part is dropped without the Check.
 */
export function partTable(
  partID: string,
  check: string,
  want: { label: string; x50: number; unit: string },
  cases: readonly PartCase[],
): void {
  for (const tc of cases) {
    test(tc.name, () => {
      const p = scoredProject();
      p.applicable(check);
      tc.build(p);
      const got = part(score(p).benchmark, partID);
      assert.equal(got.state, PartMeasured, `reason ${String(got.reason)}`);
      assert.equal(got.label, want.label);
      assert.equal(got.x50, want.x50);
      assert.equal(got.raw_unit, want.unit);
      wantScore("raw value", got.raw_value, tc.raw);
      if (tc.nEff !== undefined) {
        wantScore("n_eff", got.n_eff, tc.nEff);
      }
      wantScore("part score", got.score, tc.want);
    });
  }
  test("the part is dropped when there is nothing to examine", () => {
    const got = part(score(scoredProject()).benchmark, partID);
    assert.equal(got.state, PartNotApplicable);
    assert.deepEqual(got.source_checks, [check]);
  });
}

/**
 * withProjectTool scores the clean project with one more tool in the project
 * Context and returns its fingerprint.
 */
export function withProjectTool(tool: ToolRef | null): BenchmarkFingerprint {
  const p = scoredProject();
  const project = p.set.contexts[0];
  assert.ok(project);
  if (tool !== null) {
    project.tools.push(tool);
  }
  return fingerprintOf(p);
}
