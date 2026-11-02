import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { finalize } from "./finalize.ts";
import {
  at,
  evidence,
  goOracle,
  handMade,
  normalizePointers,
  stackTrace,
  testCase,
} from "./helpers.testutil.ts";
import {
  BenchmarkNotRequested,
  MaxEvidenceBytes,
  NotApplicable,
  OutcomeFailed,
  OutcomeObservationsOnly,
  type Outcome,
  OutcomeUnknown,
  ReasonDeselectedByFast,
  type Set,
  StatusBudgetExhausted,
  TestFailed,
  TestNeverRun,
  type TestOutcome,
  TestPassed,
} from "./types.ts";
import { validate } from "./validate.ts";
import { newBenchmark, newMetric, newService } from "./zero.ts";

/**
 * fullSet is a finalized set with a truncated evidence item, a passed-tests
 * artifact, a failed test case and a never-run one. It is valid, and every
 * mutation below breaks a rule the spec lists.
 */
function fullSet(): Set {
  const s = handMade();
  at(s.findings, 0).evidence = [evidence("tool_output", "x".repeat(6000))];
  const neverRan = testCase("test/b.js", "b never ran", TestNeverRun);
  neverRan.never_run_reason = "root hook failed";
  neverRan.attempts = [];
  s.test_cases = [
    testCase("test/a.js", "a passes", TestPassed),
    testCase("test/a.js", "a fails", TestFailed),
    neverRan,
  ];
  s.benchmark = newBenchmark({ status: BenchmarkNotRequested });
  finalize(s);
  return s;
}

test("validate accepts a full finalized set", () => {
  assert.deepEqual(validate(fullSet()), []);
});

function eachEvidence(
  s: Set,
  change: (ev: Set["findings"][number]["evidence"][number]) => void,
): void {
  for (const f of s.findings) {
    f.evidence.forEach(change);
  }
}

// The Go test's mutations, and more; the oracle holds the messages the Go
// build gives for each.
const mutations: Record<string, (s: Set) => void> = {
  "evidence text over the cap": (s) => {
    at(s.findings, 0).evidence = [
      evidence("tool_output", "y".repeat(MaxEvidenceBytes + 1)),
    ];
  },
  "cut evidence names no artifact": (s) => {
    eachEvidence(s, (ev) => {
      ev.artifact_id = null;
    });
  },
  "cut evidence claims a smaller original": (s) => {
    eachEvidence(s, (ev) => {
      ev.original_size = 10;
    });
  },
  "stack trace with more than 30 frames": (s) => {
    at(s.findings, 0).evidence = [evidence("stack_trace", stackTrace(31))];
  },
  "truncated evidence count is wrong": (s) => {
    s.report_completeness.truncated_evidence_items = 5;
  },
  "artifact content does not match its hash": (s) => {
    at(s.artifacts, 0).content = Buffer.from("changed");
  },
  "artifact path leaves the report folder": (s) => {
    at(s.artifacts, 0).path = "../escape.txt";
  },
  "artifact path is absolute": (s) => {
    at(s.artifacts, 0).path = "/etc/passwd";
  },
  "artifact path is not clean": (s) => {
    at(s.artifacts, 0).path = "artifacts//x/../y.txt";
  },
  "artifact path has a backslash": (s) => {
    at(s.artifacts, 0).path = "artifacts\\x.txt";
  },
  "artifact path is empty": (s) => {
    at(s.artifacts, 0).path = "";
  },
  "artifact path is dot": (s) => {
    at(s.artifacts, 0).path = ".";
  },
  "artifact path ends with a slash": (s) => {
    at(s.artifacts, 0).path = "artifacts/";
  },
  "artifact would overwrite report.md": (s) => {
    at(s.artifacts, 0).path = "report.md";
  },
  "two artifacts share a path": (s) => {
    at(s.artifacts, 1).path = at(s.artifacts, 0).path;
  },
  "passed test case in the list": (s) => {
    at(s.test_cases, 0).outcome = TestPassed;
  },
  "test case with an unknown outcome": (s) => {
    at(s.test_cases, 0).outcome = "weird\u0007" as TestOutcome;
  },
  "failed test case with a never-run reason": (s) => {
    at(s.test_cases, 0).never_run_reason = "x";
  },
  "never-run test case without a reason": (s) => {
    for (const tc of s.test_cases) {
      if (tc.outcome === TestNeverRun) {
        tc.never_run_reason = null;
      }
    }
  },
  "finding in a different context than its execution": (s) => {
    at(s.findings, 0).context_id = "C-0001";
  },
  "finding of a different Check than its execution": (s) => {
    at(s.findings, 0).check_id = "tests.existing";
  },
  "scope completeness does not match the executions": (s) => {
    s.summary.scope_completeness.completed = 0;
  },
  "standard completeness without a ratio": (s) => {
    s.summary.standard_completeness.ratio = null;
  },
  "run completed although a selected Check did not complete": (s) => {
    at(s.checks, 0).status = StatusBudgetExhausted;
    at(s.checks, 0).outcome = OutcomeUnknown;
  },
  "finding ID is not in sequence": (s) => {
    const old = at(s.findings, 0).id;
    at(s.findings, 0).id = "F-0042";
    for (const e of s.checks) {
      e.finding_ids = e.finding_ids.map((id) => (id === old ? "F-0042" : id));
    }
  },
  "ID with the wrong prefix": (s) => {
    at(s.test_cases, 0).id = "X-0001";
  },
  "context ID of the wrong form": (s) => {
    at(s.contexts, 2).id = "C-12\u00E9";
  },
  "deselected by --fast although the Run was not fast": (s) => {
    at(s.checks, 0).selected = false;
    at(s.checks, 0).reason_code = ReasonDeselectedByFast;
  },
  "Check both selected and deselected": (s) => {
    s.selection.deselected_checks.push(...s.selection.effective_checks);
  },
  "Finding refers to a Limitation the Report lacks": (s) => {
    at(s.findings, 0).limitations.push("service_not_started");
  },
  "summary severity counts are wrong": (s) => {
    s.summary.findings_by_severity.warning = 4;
  },
  "summary test counts are wrong": (s) => {
    s.summary.test_cases.todo = 2;
  },
  "exit code is wrong": (s) => {
    s.run.exit_code = 0;
  },
  "execution with an unknown outcome": (s) => {
    at(s.checks, 0).outcome = 'odd "one"' as Outcome;
  },
  "not applicable execution that ran": (s) => {
    at(s.checks, 0).applicability = NotApplicable;
  },
  "observations_only with a Gate": (s) => {
    at(s.checks, 1).outcome = OutcomeObservationsOnly;
  },
  "failed without a Gate": (s) => {
    at(s.checks, 0).outcome = OutcomeFailed;
  },
  "unselected execution with Findings": (s) => {
    at(s.checks, 1).selected = false;
  },
  "metric and service in unknown contexts": (s) => {
    s.metrics.push(
      newMetric({
        id: "M-0001",
        check_id: "x",
        context_id: "C-0404",
        name: "n",
        unit: "u",
      }),
    );
    s.services.push(
      newService({
        family: "valkey",
        compose_service: "cache",
        context_ids: ["C-0405"],
      }),
    );
  },
  "duplicate context IDs and an unknown test case reference": (s) => {
    s.contexts.push(at(s.contexts, 0));
    at(s.test_cases, 0).execution_id = "E-0404";
    at(s.test_cases, 0).finding_ids = ["F-0404"];
  },
  "unknown evidence artifact and execution artifact": (s) => {
    eachEvidence(s, (ev) => {
      ev.artifact_id = "A-0404";
    });
    at(s.checks, 0).artifact_ids.push("A-0405");
  },
};

describe("validate rejects every broken rule with the Go build's messages", () => {
  for (const [name, mutate] of Object.entries(mutations)) {
    test(name, () => {
      const s = fullSet();
      s.selection.effective_checks = ["syntax.parse"];
      assert.deepEqual(validate(s), [], "fixture invalid before the mutation");
      mutate(s);
      const want = goOracle.validation[`fullSet: ${name}`];
      assert.ok(want, "the oracle has the case");
      assert.deepEqual(normalizePointers(validate(s)), want);
    });
  }

  test("the oracle has no case the table lacks", () => {
    const cases = Object.keys(goOracle.validation).filter((k) =>
      k.startsWith("fullSet: "),
    );
    assert.deepEqual(
      cases.map((k) => k.slice("fullSet: ".length)).sort(),
      Object.keys(mutations).sort(),
    );
  });
});
