import { finalize } from "../finalize.ts";
import {
  Applicable,
  type Set,
  StatusBlocked,
  StatusNotStarted,
  type TestCase,
  TestFailed,
  TestNeverRun,
  TestPassed,
  TrustUntrusted,
} from "../types.ts";
import { newExecution, newMetric, newTestCase } from "../zero.ts";
import { finding } from "./findings.testutil.ts";
import { minimal } from "./sample.testutil.ts";

/**
 * golden returns the fixed result sets behind the test mode golden files, by
 * name. Each call builds new sets, finalized and valid.
 */
export function golden(): Record<string, Set> {
  return { clean: minimal(), hostile: hostile(), large: large() };
}

/** awkward is project and tool text that is as awkward as it gets. */
export const awkward =
  "line1\r\nline2\ttabbed | pipe <script>alert(1)</script> ``` fence ```` \u0007bell \u{1F600}\n" +
  "# not a heading\n- not a list\n[link](http://example.invalid)";

export function stackTrace(frames: number): string {
  let out = "Error: boom\n";
  for (let i = 0; i < frames; i++) {
    out += `    at fn${String(i)} (/app/src/f${String(i)}.js:${String(i + 1)}:1)\n`;
  }
  return out;
}

/**
 * hostile is a set whose project and tool text is as awkward as it gets, with
 * cut evidence, passed, failed and never-run test cases, a blocked and a
 * deselected execution and a Limitation.
 */
export function hostile(): Set {
  const s = minimal();
  s.checks.push(
    newExecution({
      id: "e2",
      check_id: "tests.existing",
      family: "tests",
      context_id: "C-0002",
      selected: true,
      applicability: Applicable,
      status: StatusBlocked,
      reason_code: "missing_registry_credentials",
      reason: "registry said 401 " + awkward,
    }),
    newExecution({
      id: "e3",
      check_id: "quality.size",
      family: "quality",
      context_id: "C-0001",
      selected: false,
      applicability: Applicable,
      status: StatusNotStarted,
    }),
  );
  s.selection.deselected_checks = ["quality.size"];

  const gate = finding("src/a|b.js", "Title with | pipe and <b>html</b>", true);
  gate.message = awkward;
  gate.expected = awkward;
  gate.actual = "`tick` and ``double`` and\ttab";
  gate.evidence = [
    {
      kind: "tool_output",
      text: awkward,
      origin: "node --check",
      trust: TrustUntrusted,
      original_size: null,
      artifact_id: null,
    },
    {
      kind: "tool_output",
      text: "0123456789abcdef".repeat(600),
      origin: "node --check",
      trust: TrustUntrusted,
      original_size: null,
      artifact_id: null,
    },
    {
      kind: "stack_trace",
      text: stackTrace(40),
      origin: "mocha",
      trust: TrustUntrusted,
      original_size: null,
      artifact_id: null,
    },
  ];
  const note = finding("test/fixtures/bad.js", "Note in test data", false);
  note.in_test_data = true;
  note.evidence = [
    {
      kind: "tool_output",
      text: "\u{1F600}".repeat(1500),
      origin: "node --check",
      trust: TrustUntrusted,
      original_size: null,
      artifact_id: null,
    },
  ];
  s.findings = [gate, note];

  const passed = (title: string): TestCase =>
    newTestCase({
      id: "p-" + title,
      execution_id: "E-0001",
      file: "test/a.js",
      suite: "scripts.test",
      full_title: title,
      suite_path: ["a"],
      outcome: TestPassed,
      attempts: [{ outcome: TestPassed, duration_ms: 4, error: null }],
    });
  s.test_cases = [
    passed("a one"),
    passed("a two"),
    newTestCase({
      id: "f",
      execution_id: "E-0001",
      file: "test/a.js",
      suite: "scripts.test",
      full_title: "a three | fails",
      suite_path: ["a"],
      outcome: TestFailed,
      attempts: [
        {
          outcome: TestFailed,
          duration_ms: 9,
          error: "AssertionError\n" + awkward,
        },
      ],
    }),
    newTestCase({
      id: "n",
      execution_id: "E-0001",
      file: "test/b.js",
      suite: "scripts.test",
      full_title: "b never ran",
      suite_path: ["b"],
      outcome: TestNeverRun,
      never_run_reason: "a root hook failed",
      attempts: [],
    }),
  ];
  s.limitations = [
    {
      reason_code: "build_output_skipped",
      message: "3 files skipped " + awkward,
      check_id: "syntax.parse",
      path: "dist",
    },
  ];
  s.metrics = [
    newMetric({
      id: "m",
      check_id: "syntax.parse",
      context_id: "C-0002",
      name: "files checked",
      value: 7,
      unit: "files",
    }),
  ];
  s.inventory.moved_test_files = [
    {
      context_id: "C-0002",
      path: "src/a|b.spec.js",
      suite: "test:unit",
      kind: "spec",
    },
    {
      context_id: "C-0002",
      path: "src/setup `x`.js",
      suite: "test:unit",
      kind: "require",
    },
  ];
  finalize(s);
  return s;
}

/** large has more Findings of one Check than report.md shows in full. */
export function large(): Set {
  const s = minimal();
  for (let i = 0; i < 53; i++) {
    s.findings.push(
      finding(
        `src/file${String(i).padStart(3, "0")}.js`,
        `Problem ${String(i)}`,
        i < 2,
      ),
    );
  }
  finalize(s);
  return s;
}
