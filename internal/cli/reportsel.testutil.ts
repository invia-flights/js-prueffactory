// Selecting from a report.json that a test has parsed: the one execution of a
// Check, its Findings and one of its artifacts. The test modules of the
// Suites, lint, registry and Docker tests type the parts of the Report they
// read for themselves; these functions work on any of those types.

import assert from "node:assert/strict";

/** notNotApplicable keeps the executions that were not skipped as not applicable. */
export function isApplicable(e: { applicability: string }): boolean {
  return e.applicability !== "not_applicable";
}

/**
 * onlyExecution is the one execution of a Check that passes keep. It fails the
 * test when there are none or more than one.
 */
export function onlyExecution<E extends { check_id: string }>(
  checks: readonly E[],
  check: string,
  keep: (e: E) => boolean = () => true,
): E {
  const got = checks.filter((e) => e.check_id === check && keep(e));
  assert.equal(got.length, 1, `${check} executions = ${JSON.stringify(got)}`);
  const [e] = got;
  assert.ok(e);
  return e;
}

/** findingsOfCheck are the Findings of a Check, in report order. */
export function findingsOfCheck<F extends { check_id: string }>(
  findings: readonly F[],
  check: string,
): F[] {
  return findings.filter((f) => f.check_id === check);
}

/** artifactEndingIn is the artifact of an execution whose path ends in suffix. */
export function artifactEndingIn<A extends { id: string; path: string }>(
  artifacts: readonly A[],
  e: { artifact_ids: readonly string[] },
  suffix: string,
): A | undefined {
  return artifacts.find(
    (a) => e.artifact_ids.includes(a.id) && a.path.endsWith(suffix),
  );
}
