import { compareBytes, sortStrings } from "../gocompat/strings.ts";
import { capArtifacts, capEvidence, fillArtifactDigests } from "./evidence.ts";
import { exitCode } from "./exitcode.ts";
import { normalize } from "./normalize.ts";
import { canonical, derefString, sortLists } from "./order.ts";
import { movePassedTestCases } from "./passedtests.ts";
import {
  type Completeness,
  type ExecStatus,
  type Execution,
  type Finding,
  FindingShape,
  NotApplicable,
  type Outcome,
  OutcomeFailed,
  OutcomeObservationsOnly,
  OutcomePassed,
  OutcomeUnknown,
  RunCancelled,
  RunCompleted,
  RunIncomplete,
  type Set,
  type Severity,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  TestCaseShape,
  TestFailed,
  TestNeverRun,
  TestSkipped,
  TestTodo,
} from "./types.ts";

/** id formats a final ID as Go's fmt.Sprintf("%s-%04d", prefix, n). */
export function sequenceID(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/**
 * finalize brings a result set into its final, stable shape.
 *
 * Whoever builds the set (the engine, or a test) gives executions, Findings,
 * test cases, metrics and artifacts temporary unique keys in their ID fields,
 * and refers to them by those keys. finalize sorts everything in an order that
 * never depends on which worker finished first, assigns the final IDs
 * (E-0001, F-0001, T-0001, A-0001, M-0001), rewrites every reference, derives
 * each execution's Gate count and Outcome, and fills the summary, the Run
 * status and the exit code. Context IDs are assigned by Discovery and kept.
 *
 * Every string comparison is byte-wise, as Go's.
 */
export function finalize(s: Set): void {
  capEvidence(s);
  capArtifacts(s);
  movePassedTestCases(s);
  fillArtifactDigests(s);
  const execMap = sortExecutions(s);
  const artifactMap = sortArtifacts(s);
  const findingMap = sortFindings(s, execMap, artifactMap);
  sortTestCases(s, execMap, findingMap);
  sortMetrics(s);
  sortLists(s);
  fillExecutionDerivedFields(s, artifactMap);
  fillSummary(s);
  fillRunStatus(s);
  countTruncatedEvidence(s);
  normalize(s);
}

// countTruncatedEvidence fills report_completeness from the evidence items
// that record an original size, which means they were cut.
function countTruncatedEvidence(s: Set): void {
  let n = 0;
  for (const f of s.findings) {
    for (const ev of f.evidence) {
      if (ev.original_size !== null) {
        n++;
      }
    }
  }
  s.report_completeness.truncated_evidence_items = n;
}

function sortExecutions(s: Set): Map<string, string> {
  s.checks.sort(
    (a, b) =>
      compareBytes(a.check_id, b.check_id) ||
      compareBytes(a.context_id, b.context_id),
  );
  const m = new Map<string, string>();
  s.checks.forEach((e, i) => {
    const id = sequenceID("E", i + 1);
    m.set(e.id, id);
    e.id = id;
    e.finding_ids = [];
  });
  return m;
}

function sortArtifacts(s: Set): Map<string, string> {
  s.artifacts.sort((a, b) => compareBytes(a.path, b.path));
  const m = new Map<string, string>();
  s.artifacts.forEach((a, i) => {
    const id = sequenceID("A", i + 1);
    m.set(a.id, id);
    a.id = id;
  });
  return m;
}

function severityRank(sev: Severity): number {
  switch (sev) {
    case SeverityError:
      return 0;
    case SeverityWarning:
      return 1;
    default:
      return 2;
  }
}

function firstLocation(f: Finding): [path: string, line: number] {
  const l = f.locations[0];
  if (l === undefined) {
    return ["", 0];
  }
  return [l.path, l.start?.line ?? 0];
}

function compareFindings(a: Finding, b: Finding): number {
  if (a.gate !== b.gate) {
    return a.gate ? -1 : 1;
  }
  const rank = severityRank(a.severity) - severityRank(b.severity);
  if (rank !== 0) {
    return rank;
  }
  const byCheck = compareBytes(a.check_id, b.check_id);
  if (byCheck !== 0) {
    return byCheck;
  }
  const [pa, la] = firstLocation(a);
  const [pb, lb] = firstLocation(b);
  const byPath = compareBytes(pa, pb);
  if (byPath !== 0) {
    return byPath;
  }
  if (la !== lb) {
    return la < lb ? -1 : 1;
  }
  return (
    compareBytes(derefString(a.rule_id), derefString(b.rule_id)) ||
    compareBytes(a.message, b.message) ||
    // Past the keys the spec names, every remaining field breaks ties, so
    // that the order never depends on arrival order.
    compareBytes(a.context_id, b.context_id) ||
    compareBytes(a.title, b.title) ||
    compareBytes(a.fingerprint.value, b.fingerprint.value) ||
    compareBytes(
      canonical(a, FindingShape, true),
      canonical(b, FindingShape, true),
    )
  );
}

function sortFindings(
  s: Set,
  execMap: Map<string, string>,
  artifactMap: Map<string, string>,
): Map<string, string> {
  s.findings.sort(compareFindings);
  const m = new Map<string, string>();
  const byExec = new Map<string, Execution>();
  for (const e of s.checks) {
    byExec.set(e.id, e);
  }
  s.findings.forEach((f, i) => {
    const id = sequenceID("F", i + 1);
    m.set(f.id, id);
    f.id = id;
    const newExec = execMap.get(f.execution_id);
    if (newExec !== undefined) {
      f.execution_id = newExec;
    }
    for (const ev of f.evidence) {
      if (ev.artifact_id !== null) {
        const na = artifactMap.get(ev.artifact_id);
        if (na !== undefined) {
          ev.artifact_id = na;
        }
      }
    }
    byExec.get(f.execution_id)?.finding_ids.push(id);
  });
  return m;
}

function sortTestCases(
  s: Set,
  execMap: Map<string, string>,
  findingMap: Map<string, string>,
): void {
  for (const tc of s.test_cases) {
    const n = execMap.get(tc.execution_id);
    if (n !== undefined) {
      tc.execution_id = n;
    }
    tc.finding_ids = sortStrings(
      tc.finding_ids.map((f) => findingMap.get(f) ?? f),
    );
  }
  s.test_cases.sort(
    (a, b) =>
      compareBytes(a.execution_id, b.execution_id) ||
      compareBytes(a.file, b.file) ||
      compareBytes(a.full_title, b.full_title) ||
      compareBytes(a.suite, b.suite) ||
      compareBytes(a.outcome, b.outcome) ||
      compareBytes(
        canonical(a, TestCaseShape, true),
        canonical(b, TestCaseShape, true),
      ),
  );
  s.test_cases.forEach((tc, i) => {
    tc.id = sequenceID("T", i + 1);
  });
}

function sortMetrics(s: Set): void {
  s.metrics.sort(
    (a, b) =>
      compareBytes(a.check_id, b.check_id) ||
      compareBytes(a.context_id, b.context_id) ||
      compareBytes(a.name, b.name),
  );
  s.metrics.forEach((m, i) => {
    m.id = sequenceID("M", i + 1);
  });
}

/**
 * deriveOutcome applies the Outcome rules: failed when a Gate fired (even for
 * a partial execution), passed for a completed execution without Findings,
 * observations_only for a completed one with Findings or measurements but no
 * Gate, unknown otherwise.
 */
export function deriveOutcome(
  status: ExecStatus,
  gates: number,
  hasObservations: boolean,
): Outcome {
  if (gates > 0) {
    return OutcomeFailed;
  }
  if (status !== StatusCompleted) {
    return OutcomeUnknown;
  }
  return hasObservations ? OutcomeObservationsOnly : OutcomePassed;
}

function fillExecutionDerivedFields(
  s: Set,
  artifactMap: Map<string, string>,
): void {
  const key = (check: string, ctx: string): string =>
    JSON.stringify([check, ctx]);
  const metricCount = new Map<string, number>();
  for (const m of s.metrics) {
    const k = key(m.check_id, m.context_id);
    metricCount.set(k, (metricCount.get(k) ?? 0) + 1);
  }
  const byID = new Map<string, Execution>();
  for (const e of s.checks) {
    byID.set(e.id, e);
    e.gate = 0;
  }
  for (const f of s.findings) {
    const e = byID.get(f.execution_id);
    if (e !== undefined && f.gate) {
      e.gate++;
    }
  }
  for (const e of s.checks) {
    e.artifact_ids = e.artifact_ids.map((a) => artifactMap.get(a) ?? a);
    const observed =
      e.finding_ids.length > 0 ||
      (metricCount.get(key(e.check_id, e.context_id)) ?? 0) > 0;
    e.outcome = deriveOutcome(e.status, e.gate, observed);
    if (
      !e.selected &&
      e.status === StatusCompleted &&
      e.reason_code !== null &&
      e.outcome === OutcomePassed
    ) {
      // A prerequisite that ran without being selected reports no Findings,
      // so a failure it had left no Gate behind. Its reason code says it
      // failed, and "passed" would be wrong.
      e.outcome = OutcomeUnknown;
    }
  }
}

function fillSummary(s: Set): void {
  const sum = s.summary;
  sum.findings_by_severity = { error: 0, warning: 0, note: 0 };
  sum.gates = 0;
  for (const f of s.findings) {
    switch (f.severity) {
      case SeverityError:
        sum.findings_by_severity.error++;
        break;
      case SeverityWarning:
        sum.findings_by_severity.warning++;
        break;
      default:
        sum.findings_by_severity.note++;
    }
    if (f.gate) {
      sum.gates++;
    }
  }
  // Passed test cases live in an artifact, so passed is set by whoever ran
  // the tests. The other counts always come from the list in the Report.
  const tc = sum.test_cases;
  tc.failed = 0;
  tc.skipped = 0;
  tc.todo = 0;
  tc.never_run = 0;
  for (const t of s.test_cases) {
    switch (t.outcome) {
      case TestFailed:
        tc.failed++;
        break;
      case TestSkipped:
        tc.skipped++;
        break;
      case TestTodo:
        tc.todo++;
        break;
      case TestNeverRun:
        tc.never_run++;
        break;
      default:
        break;
    }
  }
  [sum.scope_completeness, sum.standard_completeness] = completeness(s);
}

/**
 * completeness counts the executions that had to complete: Scope completeness
 * covers the selected applicable Checks, Standard completeness every
 * applicable Check of the standard scope.
 */
export function completeness(
  s: Set,
): [scope: Completeness, standard: Completeness] {
  const scope: Completeness = { required: 0, completed: 0, ratio: null };
  const standard: Completeness = { required: 0, completed: 0, ratio: null };
  for (const e of s.checks) {
    if (e.applicability === NotApplicable) {
      continue;
    }
    standard.required++;
    if (e.status === StatusCompleted) {
      standard.completed++;
    }
    if (e.selected) {
      scope.required++;
      if (e.status === StatusCompleted) {
        scope.completed++;
      }
    }
  }
  scope.ratio = ratio(scope);
  standard.ratio = ratio(standard);
  return [scope, standard];
}

function ratio(c: Completeness): number | null {
  return c.required === 0 ? null : c.completed / c.required;
}

function fillRunStatus(s: Set): void {
  if (s.run.status !== RunCancelled) {
    s.run.status = RunCompleted;
    for (const e of s.checks) {
      if (
        e.selected &&
        e.applicability !== NotApplicable &&
        e.status !== StatusCompleted
      ) {
        s.run.status = RunIncomplete;
        break;
      }
    }
  }
  s.run.exit_code = exitCode(s);
}
