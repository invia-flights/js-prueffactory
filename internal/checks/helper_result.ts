// Results that several Checks share (Go: helper_result.go).
import type { ContainerResult } from "../docker/driver.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  StatusCancelled,
  StatusInfrastructureError,
  StatusTimedOut,
  StatusToolError,
} from "../resultset/types.ts";
import { tail } from "./cut_text.ts";
import type { Input, Result } from "./input.ts";
import { errorMessage } from "../gocompat/errors.ts";

/**
 * toolsetUnavailable is the Result of a Check whose tool could not be put
 * into the toolset volume. Every Check that mounts the volume starts with
 * `if (input.toolsetVolume === "")` and returns this.
 */
export function toolsetUnavailable(input: Input, tool: string): Result {
  return {
    status: StatusInfrastructureError,
    reasonCode: "toolset_unavailable",
    reason: `the toolset volume with ${tool} could not be prepared: ${input.toolsetError}`,
  };
}

/**
 * contextErrorIn finds Go's context error in an error or the errors it wraps
 * (Go: errors.Is(err, context.DeadlineExceeded / context.Canceled)). The
 * Docker driver words them as Go does (docker/common.ts contextError) and
 * keeps the original as the cause of what it throws.
 */
export function contextErrorIn(
  err: unknown,
): "deadline" | "canceled" | undefined {
  for (let e: unknown = err, depth = 0; depth < 32; depth++) {
    if (!(e instanceof Error)) {
      return undefined;
    }
    if (e.message === "context deadline exceeded") return "deadline";
    if (e.message === "context canceled") return "canceled";
    e = e.cause;
  }
  return undefined;
}

/**
 * failedToRun marks res as the Result of a Check whose container or volume
 * could not be set up or run (Go: failedToRun in syntax_parse.go): the time
 * limit, a cancellation, or a Docker error with its text.
 */
export function failedToRun(res: Result, err: unknown): Result {
  switch (contextErrorIn(err)) {
    case "deadline":
      res.status = StatusTimedOut;
      res.reasonCode = "timeout";
      res.reason = "the Check ran into its time limit";
      break;
    case "canceled":
      res.status = StatusCancelled;
      res.reasonCode = "cancelled";
      res.reason = "the Run was cancelled";
      break;
    default:
      res.status = StatusInfrastructureError;
      res.reasonCode = "docker_error";
      res.reason = errorMessage(err);
  }
  return res;
}

/**
 * helperFailed marks res as the Result of a helper script that did not leave
 * usable output: it exited with an error, or printed something that is not
 * its JSON document. tailLen is how much of its stderr goes into the reason.
 */
export function helperFailed(
  res: Result,
  helper: string,
  c: ContainerResult,
  tailLen: number,
): Result {
  res.status = StatusToolError;
  res.reasonCode = "helper_failed";
  res.reason = `the ${helper} helper exited with ${String(c.exitCode)}: ${tail(goString(c.stderr), tailLen)}`;
  if (c.oomKilled) {
    res.reason = `the ${helper} helper ran out of memory: ${res.reason}`;
  }
  return res;
}
