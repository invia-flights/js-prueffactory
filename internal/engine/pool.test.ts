import assert from "node:assert/strict";
import { test } from "node:test";

import { background, withCancel, withTimeout } from "../gocompat/context.ts";
import {
  type ExecStatus,
  StatusBudgetExhausted,
  StatusCompleted,
  StatusNotStarted,
} from "../resultset/types.ts";
import type { Planned } from "./plan.ts";
import { type Job, schedule } from "./pool.ts";

// The scheduler on its own (Go: the pool tests in budget_test.go and
// prereq_test.go). A result is the job's letter and a status.

interface Tagged {
  id: string;
  status: ExecStatus;
}

function jobsOf(n: number, needsDocker?: (i: number) => boolean): Job[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    p: {} as Planned,
    needsDocker: needsDocker?.(i) ?? false,
    after: [],
  }));
}

function setAfter(jobs: Job[], i: number, after: number[]): void {
  const j = jobs[i];
  if (j === undefined) throw new Error("no job " + String(i));
  j.after = after;
}

function tag(j: Job, status: ExecStatus): Tagged {
  return { id: String.fromCharCode(97 + j.index), status };
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const noSkip = (j: Job): Tagged => {
  throw new Error(`job ${String(j.index)} was skipped`);
};

test("at most `workers` executions run at once", async () => {
  // Go: TestAtMostWorkersExecutionsRunAtOnce
  let running = 0;
  let peak = 0;
  const start = async (j: Job) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(20);
    running--;
    return tag(j, StatusCompleted);
  };
  const results = await schedule(background(), jobsOf(9), 3, null, start, (j) =>
    tag(j, StatusBudgetExhausted),
  );
  assert.equal(peak, 3);
  assert.equal(results.length, 9);
});

test("results come back in job order, whichever worker finished first", async () => {
  // Go: TestResultsComeBackInJobOrderWhicheverWorkerFinishedFirst
  const start = async (j: Job) => {
    await sleep((5 - j.index) * 15); // the first job finishes last
    return tag(j, StatusCompleted);
  };
  const results = await schedule(
    background(),
    jobsOf(5),
    5,
    null,
    start,
    noSkip,
  );
  assert.deepEqual(
    results.map((r) => r.id),
    ["a", "b", "c", "d", "e"],
  );
});

test("native jobs start before the Preparation ends, container jobs wait for it", async () => {
  // Go: TestNativeJobsStartBeforePreparationEndsAndContainerJobsWaitForIt
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: number[] = [];
  const start = (j: Job) => {
    order.push(j.index);
    return Promise.resolve(tag(j, StatusCompleted));
  };
  const jobs = jobsOf(4, (i) => i >= 2); // 0 and 1 are native
  const done = schedule(background(), jobs, 4, ready, start, noSkip);
  await sleep(50);
  assert.deepEqual(order, [0, 1], "only the native jobs may have started");
  release();
  const results = await done;
  assert.equal(results.length, 4);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("jobs not started when the Budget ends are skipped, running ones are not touched", async () => {
  // Go: TestJobsNotStartedWhenTheBudgetEndsAreSkippedAndRunningOnesAreNotTouched
  const budget = withCancel();
  let started = 0;
  const start = async (j: Job) => {
    started++;
    if (j.index === 1) {
      budget.cancel(); // the reserve starts while this one runs
    }
    await sleep(30);
    return tag(j, StatusCompleted);
  };
  const results = await schedule(
    budget.signal,
    jobsOf(6),
    1,
    null,
    start,
    (j) => tag(j, StatusBudgetExhausted),
  );
  assert.equal(started, 2);
  results.forEach((r, i) => {
    assert.equal(
      r.status,
      i < 2 ? StatusCompleted : StatusBudgetExhausted,
      `job ${String(i)}`,
    );
  });
});

test("container jobs are skipped when the Preparation never ends in time", async () => {
  // Go: TestContainerJobsAreSkippedWhenThePreparationNeverEndsInTime
  const budget = withTimeout(background(), 30_000_000n); // 30 ms
  const results = await schedule(
    budget.signal,
    jobsOf(3, () => true),
    2,
    new Promise<void>(() => undefined),
    (j) => Promise.resolve(tag(j, StatusCompleted)),
    (j) => tag(j, StatusBudgetExhausted),
  );
  budget.cancel();
  for (const r of results) {
    assert.equal(r.status, StatusBudgetExhausted);
  }
});

test("a job starts only after its prerequisites finished", async () => {
  // Go: TestAJobStartsOnlyAfterItsPrerequisitesFinished
  const jobs = jobsOf(3);
  setAfter(jobs, 0, [2]); // job 0 needs job 2, which comes later
  setAfter(jobs, 1, [0, 2]); // job 1 needs both
  const finished = new Set<number>();
  const start = async (j: Job) => {
    for (const dep of j.after) {
      assert.ok(
        finished.has(dep),
        `job ${String(j.index)} started before ${String(dep)} finished`,
      );
    }
    await sleep(20);
    finished.add(j.index);
    return tag(j, StatusCompleted);
  };
  const results = await schedule(background(), jobs, 3, null, start, noSkip);
  for (const r of results) {
    assert.equal(r.status, StatusCompleted);
  }
});

test("a waiting job does not hold up independent jobs", async () => {
  // Go: TestAWaitingJobDoesNotHoldUpIndependentJobs
  const jobs = jobsOf(3);
  setAfter(jobs, 0, [1]); // job 0 waits for the slow job 1
  let release = (): void => undefined;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  let independentStarted = false;
  const start = async (j: Job) => {
    if (j.index === 1) {
      await slow;
    }
    if (j.index === 2) {
      independentStarted = true;
    }
    return tag(j, StatusCompleted);
  };
  const done = schedule(background(), jobs, 3, null, start, noSkip);
  await sleep(20);
  assert.ok(independentStarted, "job 2 was held up behind job 0");
  release();
  await done;
});

test("a prerequisite does not need a free worker for its dependent to wait", async () => {
  // Go: TestAPrerequisiteDoesNotNeedAFreeWorkerForItsDependentToWait
  const jobs = jobsOf(2);
  setAfter(jobs, 0, [1]);
  const results = await schedule(
    background(),
    jobs,
    1,
    null,
    (j) => Promise.resolve(tag(j, StatusCompleted)),
    noSkip,
  );
  assert.deepEqual(
    results.map((r) => r.status),
    [StatusCompleted, StatusCompleted],
  );
});

test("when the Budget ends, waiting jobs are skipped", async () => {
  // Go: TestWhenTheBudgetEndsWaitingJobsAreSkipped
  const budget = withCancel();
  const jobs = jobsOf(2);
  setAfter(jobs, 0, [1]);
  const start = (j: Job) => {
    budget.cancel(); // the Budget ends while job 1 runs
    return Promise.resolve(tag(j, StatusCompleted));
  };
  const results = await schedule(budget.signal, jobs, 2, null, start, (j) =>
    tag(j, StatusBudgetExhausted),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    [StatusBudgetExhausted, StatusCompleted],
  );
});

test("a cycle of prerequisites ends instead of hanging", async () => {
  // Go: TestACycleOfPrerequisitesEndsInsteadOfHanging
  const jobs = jobsOf(2);
  setAfter(jobs, 0, [1]);
  setAfter(jobs, 1, [0]);
  const results = await schedule(
    background(),
    jobs,
    2,
    null,
    (j) => Promise.resolve(tag(j, StatusCompleted)),
    (j) => tag(j, StatusNotStarted),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    [StatusNotStarted, StatusNotStarted],
  );
});
