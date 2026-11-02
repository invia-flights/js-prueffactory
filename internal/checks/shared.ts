// Shared lets the Checks of one Run share the result of one expensive step,
// such as the combined ESLint run that four Checks read (Go: shared.go). The
// first Check to ask for a key does the work; the others wait for it and
// reuse the result.

interface Entry {
  done: boolean;
  val: unknown;
  // lock is the end of the last Do on this key: a Do waits for it, so one
  // computation runs at a time, as under Go's per-entry mutex.
  lock: Promise<void>;
}

export class Shared {
  readonly #entries = new Map<string, Entry>();

  #entry(key: string): Entry {
    let e = this.#entries.get(key);
    if (e === undefined) {
      e = { done: false, val: undefined, lock: Promise.resolve() };
      this.#entries.set(key, e);
    }
    return e;
  }

  /**
   * put stores a value under key, for a Check that runs later in the Run,
   * such as a dependent that reads what its prerequisite produced. It
   * replaces any value stored before.
   */
  put(key: string, val: unknown): void {
    const e = this.#entry(key);
    e.done = true;
    e.val = val;
  }

  /** get returns the value stored under key by put or do, and whether there is one. */
  get(key: string): [unknown, boolean] {
    const e = this.#entries.get(key);
    if (e === undefined) {
      return [undefined, false];
    }
    return [e.val, e.done];
  }

  /**
   * do returns the value stored under key, computing it with fn if there is
   * none. fn returns the value and whether it may be kept. A value that fn
   * computed under a cancelled or timed-out signal must not be kept, because
   * the next caller has its own signal and should try again.
   */
  async do<T>(
    signal: AbortSignal,
    key: string,
    fn: (signal: AbortSignal) => Promise<[T, boolean]>,
  ): Promise<T> {
    const e = this.#entry(key);
    const previous = e.lock;
    let release = (): void => undefined;
    e.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (e.done) {
        return e.val as T;
      }
      const [val, keep] = await fn(signal);
      if (keep) {
        e.done = true;
        e.val = val;
      }
      return val;
    } finally {
      release();
    }
  }
}

/** newShared returns an empty store. The engine makes one per Run. */
export function newShared(): Shared {
  return new Shared();
}
