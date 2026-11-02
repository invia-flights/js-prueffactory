import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "./finalize.ts";
import {
  Applicable,
  BenchmarkNotRequested,
  FormatID,
  OutcomePassed,
  OutcomeUnknown,
  RunCompleted,
  SchemaVersion,
  StatusCompleted,
} from "./types.ts";
import { validate } from "./validate.ts";
import {
  newBenchmark,
  newContext,
  newExecution,
  newRun,
  newSet,
} from "./zero.ts";

// A prerequisite that ran without being selected reports no Findings, so a
// failure it had cannot show as a Gate. Its Outcome must still not read as
// passed: it carries a reason code, and its Outcome is unknown.
test("an unselected prerequisite that failed has outcome unknown, not passed", () => {
  const s = newSet({
    format: FormatID,
    schema_version: SchemaVersion,
    run: newRun({ status: RunCompleted }),
    benchmark: newBenchmark({ status: BenchmarkNotRequested }),
    contexts: [
      newContext({ id: "C-0001", kind: "project", path: "." }),
      newContext({ id: "C-0002", kind: "package", path: "." }),
    ],
    checks: [
      newExecution({
        id: "x1",
        check_id: "package.install",
        family: "package",
        context_id: "C-0002",
        selected: false,
        applicability: Applicable,
        status: StatusCompleted,
        reason_code: "prerequisite_failed_project",
      }),
      newExecution({
        id: "x2",
        check_id: "package.manifest",
        family: "package",
        context_id: "C-0002",
        selected: false,
        applicability: Applicable,
        status: StatusCompleted,
      }),
    ],
  });

  finalize(s);

  for (const e of s.checks) {
    const want =
      e.check_id === "package.install" ? OutcomeUnknown : OutcomePassed;
    assert.equal(e.outcome, want, e.check_id);
  }
  assert.deepEqual(validate(s), []);
});
