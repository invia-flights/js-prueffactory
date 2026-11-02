// Interrupts (Go: interrupt.go). The first interrupt cancels the Run: it
// stops its Checks, cleans up and still writes a Report marked as cancelled.
// The second is the hard stop: the Run skips the Report, cleans up at once
// and exits. Both ways end in exit code 130. Later interrupts are ignored.
import { withCancel } from "../gocompat/context.ts";

/** Interrupts turns interrupt signals into cancellation. */
export interface Interrupts {
  /** signal ends on the first interrupt; pass it to main. */
  readonly signal: AbortSignal;
  /** interrupt is one SIGINT or SIGTERM. */
  interrupt(): void;
  /** stop releases the watch; later interrupts change nothing. */
  stop(): void;
}

// hardStops carries the hard-stop signal with the Run's signal, as Go's
// context carried the channel as a value.
const hardStops = new WeakMap<AbortSignal, AbortSignal>();

/**
 * withInterrupts returns the signal main runs under and the function that
 * feeds it interrupts. cmd/js-prueffactory/main.ts calls interrupt from its
 * SIGINT and SIGTERM handlers; tests call it directly.
 */
export function withInterrupts(parent?: AbortSignal): Interrupts {
  const ctx = withCancel(parent);
  const hard = new AbortController();
  hardStops.set(ctx.signal, hard.signal);
  let received = 0;
  let stopped = false;
  return {
    signal: ctx.signal,
    interrupt() {
      if (stopped) {
        return;
      }
      received++;
      if (received === 1) {
        ctx.cancel();
      } else if (received === 2) {
        hard.abort();
      }
    },
    stop() {
      stopped = true;
      ctx.cancel();
    },
  };
}

/**
 * hardStop returns the signal that ends on the second interrupt, or null
 * when the signal carries none.
 */
export function hardStop(signal: AbortSignal): AbortSignal | null {
  return hardStops.get(signal) ?? null;
}
