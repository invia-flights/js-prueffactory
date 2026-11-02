import { formatFloatFixed, formatFloatV, quote } from "../gocompat/fmt.ts";
import { exitCode } from "./exitcode.ts";
import {
  type Completeness,
  type SeverityCounts,
  type TestCounts,
} from "./types.ts";
import {
  BenchmarkComputed,
  BenchmarkIncomplete,
  BenchmarkNotRequested,
  type Execution,
  NotApplicable,
  OutcomeFailed,
  OutcomeObservationsOnly,
  OutcomePassed,
  OutcomeUnknown,
  type Set,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  StatusNotStarted,
  TestFailed,
  TestNeverRun,
  TestSkipped,
  TestTodo,
  VerdictFail,
  VerdictIncomplete,
  VerdictPass,
} from "./types.ts";
import {
  artifactRules,
  consistency,
  evidenceRules,
  idFormats,
  testCaseRules,
} from "./validate_rules.ts";

/**
 * validate checks the consistency rules the JSON Schema cannot express: every
 * reference resolves, IDs are unique, counts match their lists, status and
 * Outcome combinations are allowed and the benchmark section agrees with its
 * Verdict. It returns one message per problem, empty when the set is sound.
 * The messages are the Go build's, with Go's %q and number formats.
 */
export function validate(s: Set): string[] {
  const v = new Validator();
  references(v, s);
  executions(v, s);
  summary(v, s);
  benchmark(v, s);
  idFormats(v, s);
  evidenceRules(v, s);
  artifactRules(v, s);
  testCaseRules(v, s);
  consistency(v, s);
  const got = exitCode(s);
  if (got !== s.run.exit_code) {
    v.add(
      `run.exit_code is ${String(s.run.exit_code)} but the results map to ${String(got)}`,
    );
  }
  return v.problems;
}

/** Validator collects the problems of one validation. */
export class Validator {
  readonly problems: string[] = [];

  add(problem: string): void {
    this.problems.push(problem);
  }

  unique(kind: string, ids: readonly string[]): ReadonlySet<string> {
    const seen = new globalThis.Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        this.add(`duplicate ${kind} ID ${quote(id)}`);
      }
      seen.add(id);
    }
    return seen;
  }
}

// Go's %+v of the summary structs.
export function severityCountsText(c: SeverityCounts): string {
  return `{Error:${String(c.error)} Warning:${String(c.warning)} Note:${String(c.note)}}`;
}

export function testCountsText(c: TestCounts): string {
  return (
    `{Passed:${String(c.passed)} Failed:${String(c.failed)} Skipped:${String(c.skipped)} ` +
    `Todo:${String(c.todo)} NeverRun:${String(c.never_run)}}`
  );
}

/**
 * completenessText is Go's %+v of a Completeness, except for the ratio: Go
 * printed the address of the *float64 (`Ratio:0xc000012345`), which no build
 * can reproduce, so the value is printed instead. A missing ratio is `<nil>`.
 */
export function completenessText(c: Completeness): string {
  const ratio = c.ratio === null ? "<nil>" : formatFloatV(c.ratio);
  return `{Required:${String(c.required)} Completed:${String(c.completed)} Ratio:${ratio}}`;
}

function references(v: Validator, s: Set): void {
  const ctx = v.unique(
    "context",
    s.contexts.map((c) => c.id),
  );
  const exec = v.unique(
    "execution",
    s.checks.map((e) => e.id),
  );
  const finding = v.unique(
    "finding",
    s.findings.map((f) => f.id),
  );
  const artifact = v.unique(
    "artifact",
    s.artifacts.map((a) => a.id),
  );
  v.unique(
    "test case",
    s.test_cases.map((t) => t.id),
  );
  v.unique(
    "metric",
    s.metrics.map((m) => m.id),
  );

  const execByID = new Map<string, Execution>();
  for (const e of s.checks) {
    execByID.set(e.id, e);
    if (!ctx.has(e.context_id)) {
      v.add(
        `execution ${e.id} refers to unknown context ${quote(e.context_id)}`,
      );
    }
    for (const id of e.finding_ids) {
      if (!finding.has(id)) {
        v.add(`execution ${e.id} lists unknown finding ${quote(id)}`);
      }
    }
    for (const id of e.artifact_ids) {
      if (!artifact.has(id)) {
        v.add(`execution ${e.id} lists unknown artifact ${quote(id)}`);
      }
    }
  }
  const listed = new Map<string, string>();
  for (const e of s.checks) {
    for (const id of e.finding_ids) {
      listed.set(id, e.id);
    }
  }
  for (const f of s.findings) {
    if (!exec.has(f.execution_id)) {
      v.add(
        `finding ${f.id} refers to unknown execution ${quote(f.execution_id)}`,
      );
    } else if (execByID.get(f.execution_id)?.selected !== true) {
      v.add(
        `finding ${f.id} belongs to execution ${f.execution_id}, which was not selected and may not report Findings`,
      );
    }
    if (!ctx.has(f.context_id)) {
      v.add(`finding ${f.id} refers to unknown context ${quote(f.context_id)}`);
    }
    if ((listed.get(f.id) ?? "") !== f.execution_id) {
      v.add(`finding ${f.id} is not listed by its execution ${f.execution_id}`);
    }
    for (const ev of f.evidence) {
      if (ev.artifact_id !== null && !artifact.has(ev.artifact_id)) {
        v.add(
          `finding ${f.id} evidence refers to unknown artifact ${quote(ev.artifact_id)}`,
        );
      }
    }
  }
  for (const t of s.test_cases) {
    if (!exec.has(t.execution_id)) {
      v.add(
        `test case ${t.id} refers to unknown execution ${quote(t.execution_id)}`,
      );
    }
    for (const id of t.finding_ids) {
      if (!finding.has(id)) {
        v.add(`test case ${t.id} refers to unknown finding ${quote(id)}`);
      }
    }
  }
  for (const m of s.metrics) {
    if (!ctx.has(m.context_id)) {
      v.add(`metric ${m.id} refers to unknown context ${quote(m.context_id)}`);
    }
  }
  for (const sv of s.services) {
    for (const id of sv.context_ids) {
      if (!ctx.has(id)) {
        v.add(
          `service ${sv.compose_service} refers to unknown context ${quote(id)}`,
        );
      }
    }
  }
}

function executions(v: Validator, s: Set): void {
  const gates = new Map<string, number>();
  for (const f of s.findings) {
    if (f.gate) {
      gates.set(f.execution_id, (gates.get(f.execution_id) ?? 0) + 1);
    }
  }
  for (const e of s.checks) {
    const want = gates.get(e.id) ?? 0;
    if (e.gate !== want) {
      v.add(
        `execution ${e.id} says gate=${String(e.gate)} but has ${String(want)} Gate Findings`,
      );
    }
    if (e.applicability === NotApplicable && e.status !== StatusNotStarted) {
      v.add(
        `execution ${e.id} is not applicable but has status ${quote(e.status)}`,
      );
    }
    if (
      e.selected &&
      e.applicability !== NotApplicable &&
      e.status === StatusNotStarted
    ) {
      v.add(
        `execution ${e.id} was selected and applicable but never started and has no reason status`,
      );
    }
    switch (e.outcome as string) {
      case OutcomePassed:
        if (e.status !== StatusCompleted || e.finding_ids.length > 0) {
          v.add(
            `execution ${e.id} has outcome passed with status ${quote(e.status)} and ${String(e.finding_ids.length)} Findings`,
          );
        }
        break;
      case OutcomeFailed:
        if (e.gate === 0) {
          v.add(`execution ${e.id} has outcome failed without a Gate`);
        }
        break;
      case OutcomeObservationsOnly:
        if (e.status !== StatusCompleted || e.gate > 0) {
          v.add(
            `execution ${e.id} has outcome observations_only with status ${quote(e.status)} and gate=${String(e.gate)}`,
          );
        }
        break;
      case OutcomeUnknown:
        // Allowed for every status except that a Gate always means failed,
        // which the check after this switch covers.
        break;
      default:
        v.add(`execution ${e.id} has unknown outcome ${quote(e.outcome)}`);
    }
    if (e.gate > 0 && e.outcome !== OutcomeFailed) {
      v.add(
        `execution ${e.id} fired a Gate but has outcome ${quote(e.outcome)}`,
      );
    }
  }
}

function summary(v: Validator, s: Set): void {
  const sev: SeverityCounts = { error: 0, warning: 0, note: 0 };
  let gates = 0;
  for (const f of s.findings) {
    switch (f.severity) {
      case SeverityError:
        sev.error++;
        break;
      case SeverityWarning:
        sev.warning++;
        break;
      default:
        sev.note++;
    }
    if (f.gate) {
      gates++;
    }
  }
  if (s.summary.gates !== gates) {
    v.add(
      `summary.gates is ${String(s.summary.gates)} but ${String(gates)} Findings are Gates`,
    );
  }
  const got = s.summary.findings_by_severity;
  if (
    got.error !== sev.error ||
    got.warning !== sev.warning ||
    got.note !== sev.note
  ) {
    v.add(
      `summary.findings_by_severity ${severityCountsText(got)} does not match the Findings ${severityCountsText(sev)}`,
    );
  }
  const tc: TestCounts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    never_run: 0,
  };
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
  const have = s.summary.test_cases;
  if (
    have.failed !== tc.failed ||
    have.skipped !== tc.skipped ||
    have.todo !== tc.todo ||
    have.never_run !== tc.never_run
  ) {
    v.add(
      `summary.test_cases ${testCountsText(have)} does not match the test cases listed ${testCountsText(tc)}`,
    );
  }
}

function benchmark(v: Validator, s: Set): void {
  const b = s.benchmark;
  switch (b.status) {
    case BenchmarkNotRequested:
      if (
        b.score !== null ||
        b.range !== null ||
        b.verdict !== null ||
        b.profile_id !== null
      ) {
        v.add(
          "benchmark is not_requested but has a score, range, verdict or profile",
        );
      }
      if (
        b.areas.length > 0 ||
        b.gate_finding_ids.length > 0 ||
        b.side_indicators.length > 0 ||
        b.fingerprint !== null
      ) {
        v.add(
          "benchmark is not_requested but has areas, Gates, side indicators or a fingerprint",
        );
      }
      if (s.profiles.benchmark_profile !== null) {
        v.add(
          `benchmark is not_requested but profiles.benchmark_profile is ${quote(s.profiles.benchmark_profile)}`,
        );
      }
      if (s.run.command === "benchmark") {
        v.add(
          "the benchmark command wrote no benchmark section: it is not_requested",
        );
      }
      break;
    case BenchmarkComputed:
    case BenchmarkIncomplete:
      benchmarkScore(v, s);
      break;
    default:
      v.add(`benchmark has unknown status ${quote(b.status)}`);
  }
}

// benchmarkScore checks a benchmark section that was requested: score,
// Verdict, range, Gates and the numbers behind the score agree.
function benchmarkScore(v: Validator, s: Set): void {
  const b = s.benchmark;
  if (s.run.command !== "benchmark") {
    v.add(
      `a test mode Report (command ${quote(s.run.command)}) has a benchmark section with status ${b.status}`,
    );
  }
  if (b.verdict === null) {
    v.add(`benchmark ${b.status} has no verdict`);
    return;
  }
  let gates = 0;
  const gateIDs = new globalThis.Set<string>();
  for (const f of s.findings) {
    if (f.gate) {
      gates++;
      gateIDs.add(f.id);
    }
  }
  if (gates !== s.summary.gates) {
    v.add(
      `summary counts ${String(s.summary.gates)} Gates but ${String(gates)} Findings are Gates`,
    );
  }
  if (gates > 0 !== (b.verdict === VerdictFail)) {
    v.add(
      `benchmark verdict ${quote(b.verdict)} disagrees with ${String(gates)} Gates`,
    );
  }
  if (b.score === null && b.verdict === VerdictPass) {
    v.add("benchmark verdict is pass without a score");
  } else if (b.score !== null && b.verdict === VerdictIncomplete) {
    v.add(
      `benchmark has an incomplete verdict but a score of ${formatFloatV(b.score)}`,
    );
  }
  if (b.status === BenchmarkIncomplete && b.score !== null) {
    v.add("benchmark is incomplete but has a score");
  } else if (b.status === BenchmarkComputed && b.score === null) {
    v.add("benchmark is computed but has no score");
  }
  if (b.score !== null && (b.score < 0 || b.score > 100)) {
    v.add(`benchmark score ${formatFloatV(b.score)} is outside 0 to 100`);
  }
  if (b.range === null) {
    v.add("benchmark has no range, which is always computed");
  } else if (
    b.range.low < 0 ||
    b.range.high > 100 ||
    b.range.low > b.range.high
  ) {
    v.add(
      `benchmark range ${formatFloatV(b.range.low)} to ${formatFloatV(b.range.high)} is not inside 0 to 100 or is upside down`,
    );
  }

  if (b.profile_id === null) {
    v.add("benchmark has no profile ID");
  } else if (
    s.profiles.benchmark_profile === null ||
    s.profiles.benchmark_profile !== b.profile_id
  ) {
    v.add(
      `benchmark profile ${quote(b.profile_id)} differs from profiles.benchmark_profile`,
    );
  }

  // Go walked a map here, in random order; insertion order is one of its orders.
  const listed = new globalThis.Set(b.gate_finding_ids);
  if (
    listed.size !== b.gate_finding_ids.length ||
    listed.size !== gateIDs.size
  ) {
    v.add(
      `benchmark lists ${String(b.gate_finding_ids.length)} Gate Findings but ${String(gateIDs.size)} Findings are Gates`,
    );
  }
  for (const id of listed) {
    if (!gateIDs.has(id)) {
      v.add(`benchmark lists ${id} as a Gate, but it is not one`);
    }
  }

  if (b.areas.length === 0) {
    v.add("benchmark has no areas");
  }
  if (b.fingerprint === null) {
    v.add("benchmark has no fingerprint");
  }
  let contribution = 0;
  for (const a of b.areas) {
    if (a.contribution !== null) {
      contribution += a.contribution;
    }
    if (a.contribution !== null && b.score === null) {
      v.add(`benchmark area ${a.id} has a contribution but there is no score`);
    }
  }
  // Every contribution is rounded to one decimal, and so is the score.
  if (
    b.score !== null &&
    b.areas.length > 0 &&
    Math.abs(contribution - b.score) > 0.3
  ) {
    v.add(
      `benchmark area contributions add up to ${formatFloatFixed(contribution, 1)}, not to the score ${formatFloatFixed(b.score, 1)}`,
    );
  }
}
