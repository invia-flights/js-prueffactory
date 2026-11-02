import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  combineExitCodes,
  ExitGate,
  ExitIncomplete,
  ExitInternalError,
  ExitOK,
  exitCode,
} from "./exitcode.ts";
import {
  Applicable,
  type Applicability,
  type ExecStatus,
  type Execution,
  NotApplicable,
  RunCancelled,
  RunCompleted,
  RunIncomplete,
  type RunStatus,
  StatusBlocked,
  StatusBudgetExhausted,
  StatusCancelled,
  StatusCompleted,
  StatusNotStarted,
  StatusPartial,
  StatusTimedOut,
  StatusToolError,
  StatusUnsupported,
  Unknown,
} from "./types.ts";
import { newExecution, newRun, newSet } from "./zero.ts";

// execution builds a hand-made Check execution for the exit-code table.
function execution(
  selected: boolean,
  app: Applicability,
  status: ExecStatus,
  gate: number,
): Execution {
  return newExecution({
    check_id: "syntax.parse",
    family: "syntax",
    context_id: "C-0002",
    selected,
    applicability: app,
    status,
    gate,
  });
}

describe("exit-code mapping", () => {
  const app = Applicable;
  const na = NotApplicable;
  const unk = Unknown;
  const cases: [string, RunStatus, Execution[], number][] = [
    [
      "every selected applicable Check completed",
      RunCompleted,
      [execution(true, app, StatusCompleted, 0)],
      0,
    ],
    ["nothing to check at all", RunCompleted, [], 0],
    [
      "a Gate fires",
      RunCompleted,
      [execution(true, app, StatusCompleted, 1)],
      1,
    ],
    [
      "a Gate in a partial execution still fails",
      RunIncomplete,
      [execution(true, app, StatusPartial, 2)],
      1,
    ],
    [
      "Gate wins over an incomplete Check",
      RunIncomplete,
      [
        execution(true, app, StatusCompleted, 1),
        execution(true, app, StatusTimedOut, 0),
      ],
      1,
    ],
    [
      "incomplete applicable Check without Gate",
      RunIncomplete,
      [execution(true, app, StatusBudgetExhausted, 0)],
      2,
    ],
    [
      "incomplete Check with unknown Applicability counts",
      RunIncomplete,
      [execution(true, unk, StatusBlocked, 0)],
      2,
    ],
    [
      "unsupported counts as not completed",
      RunIncomplete,
      [execution(true, app, StatusUnsupported, 0)],
      2,
    ],
    [
      "not applicable Checks never matter",
      RunCompleted,
      [execution(true, na, StatusNotStarted, 0)],
      0,
    ],
    [
      "deselected Checks never change the exit code",
      RunCompleted,
      [execution(false, app, StatusNotStarted, 0)],
      0,
    ],
    [
      "a prerequisite run without selection fires no Gates",
      RunCompleted,
      [execution(false, app, StatusCompleted, 3)],
      0,
    ],
    [
      "a failed prerequisite does not make the Run incomplete by itself",
      RunCompleted,
      [execution(false, app, StatusToolError, 0)],
      0,
    ],
    [
      "interrupted Run",
      RunCancelled,
      [execution(true, app, StatusCancelled, 0)],
      130,
    ],
    [
      "interruption wins over a Gate",
      RunCancelled,
      [execution(true, app, StatusCompleted, 1)],
      130,
    ],
  ];
  for (const [name, status, checks, want] of cases) {
    test(name, () => {
      const s = newSet({ run: newRun({ status }), checks });
      assert.equal(exitCode(s), want);
    });
  }
});

test("exit-code priority is 3, 1, 2, 0", () => {
  const cases: [number, number, number][] = [
    [ExitInternalError, ExitGate, 3],
    [ExitGate, ExitIncomplete, 1],
    [ExitIncomplete, ExitOK, 2],
    [ExitOK, ExitOK, 0],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(
      combineExitCodes(a, b),
      want,
      `combineExitCodes(${String(a)}, ${String(b)})`,
    );
    assert.equal(
      combineExitCodes(b, a),
      want,
      `combineExitCodes(${String(b)}, ${String(a)})`,
    );
  }
});
