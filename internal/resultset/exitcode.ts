import {
  NotApplicable,
  RunCancelled,
  type Set,
  StatusCompleted,
} from "./types.ts";

// Exit codes of js-prueffactory.
export const ExitOK = 0;
export const ExitGate = 1;
export const ExitIncomplete = 2;
export const ExitInternalError = 3; // usage error, Docker unreachable, internal error
export const ExitInterrupted = 130;

/**
 * exitCode maps a finished result set to an exit code. Priority is 3, 1, 2, 0;
 * code 3 never comes out of a result set because a Run that fails that way has
 * no Report, so use combineExitCodes for it. An interrupted Run is always 130.
 *
 * Only selected Checks count. Prerequisites that ran without being selected
 * report no Gates and cannot make the Run incomplete, and deselected Checks
 * never change the exit code.
 */
export function exitCode(s: Set): number {
  if (s.run.status === RunCancelled) {
    return ExitInterrupted;
  }
  let code = ExitOK;
  for (const e of s.checks) {
    if (!e.selected) {
      continue;
    }
    if (e.gate > 0) {
      code = combineExitCodes(code, ExitGate);
      continue;
    }
    if (e.applicability !== NotApplicable && e.status !== StatusCompleted) {
      code = combineExitCodes(code, ExitIncomplete);
    }
  }
  return code;
}

/**
 * combineExitCodes returns the code with the higher priority. The priority
 * order is 3, 1, 2, 0. Code 130 is not part of the order and is handled by the
 * caller.
 */
export function combineExitCodes(a: number, b: number): number {
  return priority(a) >= priority(b) ? a : b;
}

function priority(code: number): number {
  switch (code) {
    case ExitInternalError:
      return 3;
    case ExitGate:
      return 2;
    case ExitIncomplete:
      return 1;
    default:
      return 0;
  }
}
