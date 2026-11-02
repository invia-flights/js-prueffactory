// Go's context package on top of AbortSignal: cancellation that flows from a
// parent to its children, deadlines, and Go's two errors. A Run has three
// levels (the Run, the Budget, one execution), and why an execution ended is
// read from which of them ended (engine/budget.ts endReason), so a signal
// must say whether it was cancelled or ran out of time, as ctx.Err() does.
//
// The reason of a signal that ran out of time is a DOMException named
// "TimeoutError", like AbortSignal.timeout's, so docker/common.ts contextError
// words it as "context deadline exceeded"; a cancelled one has an "AbortError".

import { type Duration, millisecond } from "./time.ts";

/** Context is a signal and the function that cancels it (Go's CancelFunc). */
export interface Context {
  readonly signal: AbortSignal;
  /** cancel ends the signal with "context canceled" unless it ended already, and releases its timer. */
  cancel(): void;
}

// Node clamps a timer above 2^31-1 ms to 1 ms; longer waits are chained.
const maxTimerMs = 2 ** 31 - 1;

/** canceledReason is the reason of a cancelled signal. */
export function canceledReason(): DOMException {
  return new DOMException("context canceled", "AbortError");
}

/** deadlineReason is the reason of a signal whose deadline passed. */
export function deadlineReason(): DOMException {
  return new DOMException("context deadline exceeded", "TimeoutError");
}

/** isDeadline says whether a signal ended because its deadline passed (Go: ctx.Err() == context.DeadlineExceeded). */
export function isDeadline(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return (
    signal.aborted && reason instanceof Error && reason.name === "TimeoutError"
  );
}

/** background is a signal that never ends (Go's context.Background). */
export function background(): AbortSignal {
  return new AbortController().signal;
}

/** withCancel is Go's context.WithCancel. */
export function withCancel(parent?: AbortSignal): Context {
  return derive(parent, undefined);
}

/**
 * withDeadline is Go's context.WithDeadline: the signal ends at deadline
 * (milliseconds since the epoch) with "context deadline exceeded", or with
 * the parent. A deadline in the past ends it at once.
 */
export function withDeadline(parent: AbortSignal, deadline: number): Context {
  return derive(parent, deadline);
}

/** withTimeout is Go's context.WithTimeout for a Duration. */
export function withTimeout(parent: AbortSignal, d: Duration): Context {
  return derive(parent, Date.now() + Number(d / millisecond));
}

function derive(parent: AbortSignal | undefined, deadline?: number): Context {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const release = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parent?.removeEventListener("abort", onParent);
  };
  const end = (reason: unknown): void => {
    release();
    if (!ctl.signal.aborted) {
      ctl.abort(reason);
    }
  };
  function onParent(): void {
    end(parent?.reason);
  }
  if (parent?.aborted) {
    ctl.abort(parent.reason);
    return { signal: ctl.signal, cancel: () => undefined };
  }
  parent?.addEventListener("abort", onParent, { once: true });
  if (deadline !== undefined) {
    const arm = (): void => {
      const left = deadline - Date.now();
      if (left <= 0) {
        end(deadlineReason());
        return;
      }
      timer = setTimeout(arm, Math.min(left, maxTimerMs));
    };
    arm();
  }
  return {
    signal: ctl.signal,
    cancel: () => {
      end(canceledReason());
    },
  };
}

/** done resolves when the signal ends. */
export function done(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
