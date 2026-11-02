// How the engine schedules the Checks that repeat the runs of a suite (Go:
// flaky_test.go and unhandled_rejections_test.go of the engine package).
// tests.flaky repeats the suites after the shared first run. It is scheduled
// right after tests.existing, ahead of the static Checks. runtime.unhandled-
// rejections makes its strict run after the shared first run and, when
// tests.flaky runs, after the repeat runs of that Check. It never makes
// tests.flaky run. The Check's own limit handling is in assemble.test.ts.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { catalog } from "../checks/catalog.ts";
import { resolve } from "../checks/selection.ts";
import { discover } from "../discovery/discovery.ts";
import { hour } from "../gocompat/time.ts";
import {
  entry,
  fakeCheck,
  planned,
  tempDir,
  writeTree,
} from "./engine.testutil.ts";
import { isTestSuite, testSuiteTimeout, timeLimit } from "./budget.ts";
import { plan, type Planned, runnable } from "./plan.ts";
import type { Job } from "./pool.ts";
import { linkAfter, orderJobs } from "./schedule.ts";

function planProjectWithTests(t: TestContext, ...only: string[]): Planned[] {
  const root = tempDir(t);
  writeTree(root, {
    "package.json": `{"name":"demo","scripts":{"test":"mocha"},"devDependencies":{"mocha":"^10.0.0"}}`,
    "test/a.test.js": "it('x', () => {})\n",
    "package-lock.json": "{}",
  });
  return plan(discover(root), resolve(catalog(), only, []));
}

function plannedOf(all: Planned[], check: string): Planned {
  const p = all.find((x) => x.entry.id === check && x.context.package !== null);
  assert.ok(p, `${check} is not planned`);
  return p;
}

const jobOf = (index: number, p: Planned): Job => ({
  index,
  p,
  needsDocker: false,
  after: [],
});

function jobFor(check: string, docker: boolean, ...needs: Planned[]): Job {
  const p = planned({
    entry: entry(check),
    check: fakeCheck({ status: "completed" }),
    needs,
  });
  return { index: 0, p, needsDocker: docker, after: [] };
}

test("tests.flaky follows tests.existing of its package", (t) => {
  const all = planProjectWithTests(t);
  const flaky = plannedOf(all, "tests.flaky");
  const existing = plannedOf(all, "tests.existing");

  assert.ok(
    flaky.follows.includes(existing),
    "tests.flaky follows tests.existing of its package",
  );
  assert.deepEqual(
    flaky.needs.map((n) => n.entry.id),
    ["package.install"],
    "the install only: a failing suite is what it is for",
  );
});

test("the first run happens even when tests.existing is not selected", (t) => {
  const all = planProjectWithTests(t, "tests.flaky");
  const existing = plannedOf(all, "tests.existing");

  assert.ok(
    existing.deselected && existing.prerequisite && runnable(existing),
    `tests.existing: deselected ${String(existing.deselected)}, prerequisite ${String(existing.prerequisite)}, runnable ${String(runnable(existing))}; it must run, and be reported as not selected`,
  );
});

test("the scheduler starts tests.flaky only after tests.existing finished", (t) => {
  const all = planProjectWithTests(t);
  const flaky = plannedOf(all, "tests.flaky");
  const existing = plannedOf(all, "tests.existing");
  const jobs = [jobOf(0, flaky), jobOf(1, existing)];

  linkAfter(jobs);

  assert.ok(
    jobs[0]?.after.includes(1),
    "tests.flaky waits for the position of tests.existing (1), wherever it is in the list",
  );
  assert.ok(
    !jobs[1]?.after.includes(0),
    "tests.existing must not wait for tests.flaky",
  );
});

test("tests.flaky runs with the suites ahead of static Checks and has no time limit of its own beyond the Budget", () => {
  assert.ok(
    isTestSuite("tests.flaky"),
    "the repeat runs take as long as the suites, so they are scheduled with them",
  );
  assert.ok(
    timeLimit("tests.flaky") >= 6n * testSuiteTimeout,
    `timeLimit ${String(timeLimit("tests.flaky"))}: every repeat run has the suite limit, so the execution must not cut them short`,
  );
  assert.equal(testSuiteTimeout, 30n * 60n * 1_000_000_000n);

  const syntax = jobFor("syntax.parse", true);
  const install = jobFor("package.install", true);
  const suite = jobFor("tests.existing", true, install.p);
  const flaky = jobFor("tests.flaky", true, install.p);
  const lint = jobFor("lint.existing", true);
  const jobs = [syntax, install, suite, lint, flaky];
  orderJobs(jobs);
  assert.deepEqual(
    jobs.map((j) => j.p.entry.id),
    [
      "package.install",
      "tests.existing",
      "tests.flaky",
      "syntax.parse",
      "lint.existing",
    ],
  );
});

// --- runtime.unhandled-rejections ---

test("runtime.unhandled-rejections follows tests.existing and runs it as a prerequisite", (t) => {
  const all = planProjectWithTests(t, "runtime.unhandled-rejections");
  const strict = plannedOf(all, "runtime.unhandled-rejections");
  const existing = plannedOf(all, "tests.existing");

  assert.ok(
    strict.follows.includes(existing),
    "follows tests.existing of its package",
  );
  assert.ok(
    existing.deselected && existing.prerequisite && runnable(existing),
    "the first run must happen",
  );
  assert.deepEqual(
    strict.needs.map((n) => n.entry.id),
    ["package.install"],
    "the install only",
  );
});

test("runtime.unhandled-rejections starts after tests.flaky when it is selected and does not select it", (t) => {
  const all = planProjectWithTests(t, "runtime.unhandled-rejections");
  const strict = plannedOf(all, "runtime.unhandled-rejections");
  const flaky = plannedOf(all, "tests.flaky");

  assert.ok(strict.orderedAfter.includes(flaky), "orderedAfter tests.flaky");
  assert.equal(
    runnable(flaky),
    false,
    "tests.flaky is deselected: the strict run must not make it run",
  );
});

test("the scheduler starts the strict run only after tests.flaky finished", (t) => {
  const all = planProjectWithTests(t);
  const strict = plannedOf(all, "runtime.unhandled-rejections");
  const flaky = plannedOf(all, "tests.flaky");
  const jobs = [jobOf(0, strict), jobOf(1, flaky)];

  linkAfter(jobs);

  assert.ok(
    jobs[0]?.after.includes(1),
    "the strict run waits for tests.flaky (1)",
  );
  assert.deepEqual(jobs[1]?.after, [], "tests.flaky waits for nothing");
});

test("a job whose ordering predecessor is not a job just starts", (t) => {
  const all = planProjectWithTests(t, "runtime.unhandled-rejections");
  const strict = plannedOf(all, "runtime.unhandled-rejections");
  const jobs = [jobOf(0, strict)];

  linkAfter(jobs);

  assert.deepEqual(jobs[0]?.after, [], "tests.flaky is not part of this Run");
});

test("the strict run is scheduled with the suites and has only the Budget as its limit", () => {
  assert.ok(
    isTestSuite("runtime.unhandled-rejections"),
    "the strict run takes as long as a suite, so it is scheduled with them",
  );
  const limit = timeLimit("runtime.unhandled-rejections");
  assert.ok(
    limit >= 2n * testSuiteTimeout && limit >= hour,
    `timeLimit ${String(limit)}: the run has the suite limit itself and the Check must keep its partial result`,
  );
});
