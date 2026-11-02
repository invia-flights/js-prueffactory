// The scheduler of the Check executions (Go: pool.go).
import type { Planned } from "./plan.ts";

/** Job is one runnable Check execution waiting for a slot. */
export interface Job {
  /**
   * index is the position of the execution in the plan, which is also its
   * place in the Report, whichever worker finishes first.
   */
  index: number;
  p: Planned;
  /** needsDocker says whether the execution waits for the Preparation phase. */
  needsDocker: boolean;
  /**
   * after holds the positions, in the list given to schedule, of the jobs
   * that must have finished before this one starts. They may come later in
   * the list. It is how prerequisites such as the install are ordered.
   */
  after: number[];
}

type Event = { kind: "done"; i: number } | { kind: "ready" | "budget" };

/**
 * schedule starts the jobs in the given order, at most workers at a time,
 * and returns one result per job in the same order.
 *
 * A job starts when it has a free worker, all the jobs it waits for (after)
 * have finished and, if it needs Docker, ready has resolved; a null ready
 * means there is nothing to wait for. Of the jobs that may start, the first
 * in the list goes first, and a job that has to wait never holds up the
 * others. When budget ends, jobs that have not started are handed to skip
 * instead, and jobs that are running are left to notice the end themselves,
 * because they run under signals derived from budget.
 */
export async function schedule<R>(
  budget: AbortSignal,
  jobs: readonly Job[],
  workers: number,
  ready: Promise<void> | null,
  start: (j: Job) => Promise<R>,
  skip: (j: Job) => R,
): Promise<R[]> {
  const results = new Array<R>(jobs.length);
  const finished = new Array<boolean>(jobs.length).fill(false);
  let pending = jobs.map((_, i) => i);

  // Events arrive in a queue; the loop waits for the next one, as Go's
  // select waits on its channels.
  const queue: Event[] = [];
  let wake: (() => void) | null = null;
  const push = (e: Event): void => {
    queue.push(e);
    const w = wake;
    wake = null;
    w?.();
  };
  const next = async (): Promise<Event> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return at(queue.splice(0, 1), 0);
  };

  let isReady = ready === null;
  let waitReady = ready !== null; // false once ready has resolved
  void ready?.then(() => {
    push({ kind: "ready" });
  });
  let waitBudget = true;
  const onBudget = (): void => {
    push({ kind: "budget" });
  };
  budget.addEventListener("abort", onBudget, { once: true });

  let running = 0;
  let stopped = false;
  const mayStart = (j: Job): boolean => {
    if (j.needsDocker && !isReady) {
      return false;
    }
    return j.after.every(
      (dep) => dep >= 0 && dep < finished.length && finished[dep] === true,
    );
  };
  const skipPending = (): void => {
    for (const i of pending) {
      results[i] = skip(at(jobs, i));
    }
    pending = [];
  };

  try {
    while (pending.length > 0 || running > 0) {
      // The Budget wins over everything that is ready at the same moment.
      if (!stopped && budget.aborted) {
        stopped = true;
      }
      if (stopped) {
        skipPending();
      }
      if (!stopped && running < workers) {
        const k = pending.findIndex((i) => mayStart(at(jobs, i)));
        if (k >= 0) {
          const i = at(pending, k);
          pending = [...pending.slice(0, k), ...pending.slice(k + 1)];
          running++;
          void start(at(jobs, i)).then((res) => {
            results[i] = res;
            push({ kind: "done", i });
          });
          continue;
        }
        if (running === 0 && !waitReady && pending.length > 0) {
          // Nothing runs and nothing can start: the jobs wait for each
          // other. That is a planning error, and it must not hang the Run.
          skipPending();
        }
      }
      if (pending.length === 0 && running === 0) {
        break;
      }
      const e = await next();
      switch (e.kind) {
        case "done":
          running--;
          finished[e.i] = true;
          break;
        case "ready":
          isReady = true;
          waitReady = false;
          break;
        case "budget":
          if (waitBudget) {
            stopped = true;
            waitBudget = false;
          }
          break;
      }
    }
  } finally {
    budget.removeEventListener("abort", onBudget);
  }
  return results;
}

// at is xs[i] for an index known to be in range.
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) {
    throw new Error(`engine: index ${String(i)} out of range`);
  }
  return x;
}
