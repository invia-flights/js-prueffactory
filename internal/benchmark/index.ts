import {
  type Execution,
  type Finding,
  NotApplicable,
  PartReasonDeselectedByFast,
  ReasonDeselectedByFast,
  type Set,
  StatusBlocked,
  StatusCompleted,
} from "../resultset/types.ts";

/** Index looks up executions and Findings of a result set once. */
export interface Index {
  readonly set: Set;
  /** execsOf holds the executions by Check ID, in report order. */
  readonly execsOf: ReadonlyMap<string, readonly Execution[]>;
  /** findingsOf holds the Findings by execution ID. */
  readonly findingsOf: ReadonlyMap<string, readonly Finding[]>;
}

function push<T>(m: Map<string, T[]>, key: string, v: T): void {
  const list = m.get(key);
  if (list === undefined) {
    m.set(key, [v]);
  } else {
    list.push(v);
  }
}

export function indexSet(s: Set): Index {
  const execsOf = new Map<string, Execution[]>();
  const findingsOf = new Map<string, Finding[]>();
  for (const e of s.checks) {
    push(execsOf, e.check_id, e);
  }
  for (const f of s.findings) {
    push(findingsOf, f.execution_id, f);
  }
  return { set: s, execsOf, findingsOf };
}

export function execsOf(idx: Index, check: string): readonly Execution[] {
  return idx.execsOf.get(check) ?? [];
}

export function findingsOf(
  idx: Index,
  executionID: string,
): readonly Finding[] {
  return idx.findingsOf.get(executionID) ?? [];
}

/** ExecClass says what an execution means for the Benchmark. */
export type ExecClass = "measured" | "fault" | "unknown";

/** classMeasured: the execution was selected and completed. */
export const classMeasured: ExecClass = "measured";
/**
 * classFault: a prerequisite failed because of the project, so there was
 * nothing to examine.
 */
export const classFault: ExecClass = "fault";
/**
 * classUnknown: the Run did not measure it. That covers every status other
 * than completed, and Checks that were deselected.
 */
export const classUnknown: ExecClass = "unknown";

/**
 * reasonPrerequisiteFailedProject is the reason code the engine gives a
 * dependent execution whose prerequisite failed because of the project.
 */
export const reasonPrerequisiteFailedProject = "prerequisite_failed_project";

export function classify(e: Execution): ExecClass {
  if (
    e.selected &&
    e.status === StatusBlocked &&
    e.reason_code === reasonPrerequisiteFailedProject
  ) {
    return classFault;
  }
  if (!e.selected) {
    return classUnknown;
  }
  if (e.status === StatusCompleted) {
    return classMeasured;
  }
  return classUnknown;
}

/** isApplicable is false for an execution with nothing to examine. */
export function isApplicable(e: Execution): boolean {
  return e.applicability !== NotApplicable;
}

/**
 * unknownReason says why the first unmeasured execution was not measured,
 * with the number of the others.
 */
export function unknownReason(unknown: readonly Execution[]): string {
  const e = unknown[0];
  if (e === undefined) {
    throw new Error("benchmark: unknownReason of no execution");
  }
  let reason: string = e.status;
  if (!e.selected && e.reason_code === ReasonDeselectedByFast) {
    reason = PartReasonDeselectedByFast;
  } else if (!e.selected) {
    reason = "deselected";
  } else if (e.reason_code !== null) {
    reason += ": " + e.reason_code;
  }
  if (unknown.length > 1) {
    reason += ` (and ${String(unknown.length - 1)} more)`;
  }
  return reason;
}
