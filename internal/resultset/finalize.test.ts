import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { marshal } from "../gocompat/json.ts";
import { ExitGate, ExitIncomplete, ExitOK } from "./exitcode.ts";
import { finalize } from "./finalize.ts";
import {
  at,
  goOracle,
  handMade,
  normalizePointers,
} from "./helpers.testutil.ts";
import {
  BenchmarkNotRequested,
  OutcomeFailed,
  OutcomePassed,
  OutcomeUnknown,
  ReportShape,
  RunCompleted,
  RunIncomplete,
  type Set,
  StatusBudgetExhausted,
  StatusNotStarted,
} from "./types.ts";
import { validate } from "./validate.ts";
import { newBenchmark } from "./zero.ts";

function json(s: Set): string {
  return marshal(s, ReportShape);
}

test("finalize assigns IDs in stable order whatever the arrival order", () => {
  const a = handMade();
  const b = handMade();
  b.findings.reverse();
  b.checks.reverse();

  finalize(a);
  finalize(b);

  assert.equal(
    json(a),
    json(b),
    "different arrival order produced different results",
  );
  // Gates first, then by path: gate a, gate b, then the note.
  assert.deepEqual(
    a.findings.map((f) => `${f.id}:${at(f.locations, 0).path}`),
    ["F-0001:a.js", "F-0002:b.js", "F-0003:z.js"],
  );
  // Executions sort by Check ID then Context ID.
  assert.equal(at(a.checks, 0).id, "E-0001");
  assert.equal(at(a.checks, 0).context_id, "C-0002");
  assert.equal(at(a.checks, 1).context_id, "C-0003");
  // Findings point at the new execution IDs, and executions list their Findings.
  for (const f of a.findings) {
    assert.equal(f.execution_id, "E-0002", `finding ${f.id}`);
  }
  assert.deepEqual(at(a.checks, 1).finding_ids, ["F-0001", "F-0002", "F-0003"]);
});

test("finalize derives the Outcome and the summary", () => {
  const s = handMade();
  finalize(s);

  const [clean, failing] = [at(s.checks, 0), at(s.checks, 1)];
  assert.equal(clean.outcome, OutcomePassed);
  assert.equal(clean.gate, 0);
  assert.equal(failing.outcome, OutcomeFailed);
  assert.equal(failing.gate, 2);
  assert.equal(s.summary.gates, 2);
  assert.equal(s.summary.findings_by_severity.error, 2);
  assert.equal(s.summary.findings_by_severity.note, 1);
  assert.equal(s.summary.scope_completeness.required, 2);
  assert.equal(s.summary.scope_completeness.completed, 2);
  assert.equal(s.run.exit_code, ExitGate);
  assert.equal(s.run.status, RunCompleted);
  assert.deepEqual(validate(s), [], "finalized set is invalid");
});

test("finalize marks the Run incomplete when a selected Check did not complete", () => {
  const s = handMade();
  s.findings = [];
  at(s.checks, 0).status = StatusBudgetExhausted;
  finalize(s);

  assert.equal(s.run.status, RunIncomplete);
  assert.equal(s.run.exit_code, ExitIncomplete);
  assert.equal(
    at(s.checks, 1).outcome,
    OutcomeUnknown,
    "outcome of a non-completed execution",
  );
  assert.equal(s.summary.scope_completeness.required, 2);
  assert.equal(s.summary.scope_completeness.completed, 1);
});

test("a deselected Check lowers Standard but not Scope completeness, and never the exit code", () => {
  const s = handMade();
  s.findings = [];
  // One of the two applicable Checks is left out by --exclude.
  at(s.checks, 0).selected = false;
  at(s.checks, 0).status = StatusNotStarted;
  finalize(s);

  assert.deepEqual(s.summary.scope_completeness, {
    required: 1,
    completed: 1,
    ratio: 1,
  });
  assert.deepEqual(s.summary.standard_completeness, {
    required: 2,
    completed: 1,
    ratio: 0.5,
  });
  assert.equal(s.run.exit_code, ExitOK);
  assert.equal(s.run.status, RunCompleted);
  assert.deepEqual(
    validate(s),
    [],
    "a Report with a deselected Check is invalid",
  );
});

describe("validate rejects inconsistent sets", () => {
  const mutations: Record<string, (s: Set) => void> = {
    "finding points at an unknown execution": (s) => {
      at(s.findings, 0).execution_id = "E-9999";
    },
    "finding points at an unknown context": (s) => {
      at(s.findings, 0).context_id = "C-9999";
    },
    "duplicate finding ID": (s) => {
      at(s.findings, 1).id = at(s.findings, 0).id;
    },
    "passed outcome with Findings": (s) => {
      at(s.checks, 1).outcome = OutcomePassed;
    },
    "gate count does not match Findings": (s) => {
      at(s.checks, 1).gate = 7;
    },
    "summary gate count is wrong": (s) => {
      s.summary.gates = 9;
    },
    "execution lists an unknown finding": (s) => {
      at(s.checks, 1).finding_ids.push("F-4242");
    },
    "selected applicable Check never started": (s) => {
      at(s.checks, 0).status = StatusNotStarted;
    },
    "benchmark not requested but scored": (s) => {
      s.benchmark = newBenchmark({ status: BenchmarkNotRequested, score: 50 });
    },
    "benchmark with an unknown status": (s) => {
      s.benchmark = newBenchmark({ status: "maybe" });
    },
    "benchmark not requested but a profile": (s) => {
      s.profiles.benchmark_profile = "benchmark-v1-uncalibrated";
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    test(name, () => {
      const s = handMade();
      finalize(s);
      s.benchmark = newBenchmark({ status: BenchmarkNotRequested });
      mutate(s);
      const problems = validate(s);
      assert.notDeepEqual(
        problems,
        [],
        "validate accepted an inconsistent set",
      );
      // The same messages as the Go build.
      assert.deepEqual(
        normalizePointers(problems),
        goOracle.validation[`handMade: ${name}`],
      );
    });
  }
});
