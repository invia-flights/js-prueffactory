// What one planned execution produced, and the Report entries of executions
// that never ran (Go: the top of schedule.go). A module of its own, so that
// the scheduler, the prerequisites and the redaction hook share it without
// importing each other.
import type {
  Artifact,
  ExecStatus,
  Execution,
  Finding,
  Inventory,
  Limitation,
  Metric,
  Service,
  TestCase,
  ToolRef,
} from "../resultset/types.ts";
import {
  ReasonDeselectedByFast,
  StatusNotStarted,
} from "../resultset/types.ts";
import { newExecution } from "../resultset/zero.ts";
import type { Planned } from "./plan.ts";

/** ExecResult is everything one planned execution produced. */
export interface ExecResult {
  p: Planned;
  exec: Execution;
  findings: Finding[];
  metrics: Metric[];
  limitations: Limitation[];
  inventory: Inventory | null;
  artifacts: Artifact[];
  testCases: TestCase[];
  /** services are the test Services the execution started or failed to start. */
  services: Service[];
  /**
   * gates is the number of Gate Findings the Check produced, also when they
   * were left out of the Report because the execution was not selected.
   * failure says what the first one was about. A dependent reads both.
   */
  gates: number;
  failure: string;
  /**
   * redact holds secret values the Check found. It survives when the Check
   * is only a prerequisite.
   */
  redact: (string | Uint8Array)[];
  /**
   * contextTools are the tools the Check used, to be recorded in its
   * Context. They survive when the Check is only a prerequisite.
   */
  contextTools: ToolRef[];
  /** registryDate is when the registry data the Check read was fetched, or null. */
  registryDate: Date | null;
}

/** execResult is an ExecResult with the fields that are not named left empty. */
export function execResult(
  p: Planned,
  exec: Execution,
  fields: Partial<ExecResult> = {},
): ExecResult {
  return {
    p,
    exec,
    findings: [],
    metrics: [],
    limitations: [],
    inventory: null,
    artifacts: [],
    testCases: [],
    services: [],
    gates: 0,
    failure: "",
    redact: [],
    contextTools: [],
    registryDate: null,
    ...fields,
  };
}

/** strPtr is Go's strPtr: null for the empty string. */
export function strPtr(s: string | undefined): string | null {
  return s === undefined || s === "" ? null : s;
}

/** newExec starts the Report entry of a planned execution. */
export function newExec(p: Planned): Execution {
  return newExecution({
    id: p.key,
    check_id: p.entry.id,
    family: p.entry.family,
    context_id: p.context.id,
    selected: !p.deselected,
    applicability: p.applicability,
    status: StatusNotStarted,
    finding_ids: [],
    artifact_ids: [],
  });
}

/** deselectedResult is the Report entry of a Check the Selection leaves out. */
export function deselectedResult(p: Planned): ExecResult {
  const e = newExec(p);
  e.selected = false;
  e.reason_code = "deselected";
  e.reason = "left out by --only or --exclude";
  if (p.byFast) {
    e.reason_code = ReasonDeselectedByFast;
    e.reason = "skipped by --fast";
  }
  return execResult(p, e);
}

/** stopped is an execution that never started, or that the Run ended. */
export function stopped(
  p: Planned,
  status: ExecStatus,
  code: string,
  reason: string,
): ExecResult {
  const e = newExec(p);
  e.status = status;
  e.reason_code = strPtr(code);
  e.reason = strPtr(reason);
  return execResult(p, e);
}
