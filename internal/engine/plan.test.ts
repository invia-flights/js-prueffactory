import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { catalog } from "../checks/catalog.ts";
import { resolve } from "../checks/selection.ts";
import { discover, type Project } from "../discovery/discovery.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { StatusInfrastructureError } from "../resultset/types.ts";
import { newExecution } from "../resultset/zero.ts";
import {
  entry,
  fakeCheck,
  planned,
  runState,
  tempDir,
  writeTree,
} from "./engine.testutil.ts";
import { execResult } from "./execution.ts";
import { plan, type Planned, runnable } from "./plan.ts";
import type { Job } from "./pool.ts";
import {
  blockedByPrerequisite,
  resolvePrerequisites,
} from "./prerequisites.ts";
import { linkAfter, orderJobs } from "./schedule.ts";

// The Checks that read File classes wait for the probe of the packages whose
// files they examine, which runs at the end of the package's install. Checks
// that do not read File classes do not wait (Go: probe_waits_test.go).

function probeProject(t: TestContext): Project {
  const root = tempDir(t);
  writeTree(root, {
    "package.json": `{"scripts":{"test":"mocha"}}`,
    "src/a.js": "",
    "api/package.json": `{"scripts":{"test":"node --test"}}`,
    "api/src/b.js": "",
    "docs/package.json": `{"name":"no-tests"}`,
    "pnpm/package.json": `{"scripts":{"test":"mocha"}}`,
    "pnpm/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm/src/c.js": "",
    "docs/src/d.js": "",
    "unsupported/package.json": `{"scripts":{"test":"jest"}}`,
  });
  return discover(root);
}

function plannedFor(proj: Project, ...only: string[]): Planned[] {
  return plan(proj, resolve(catalog(), only, []));
}

// waitsOf lists the packages whose install the execution waits for.
function waitsOf(p: Planned): string[] {
  return sortStrings(
    p.waits.map((q) =>
      q.entry.id === "package.install"
        ? (q.context.package?.path ?? "?")
        : "?" + q.entry.id,
    ),
  );
}

function executionsOf(all: Planned[], check: string): Planned[] {
  return all.filter((p) => p.entry.id === check);
}

test("a project Check that reads File classes waits for the install of every package with a test probe", (t) => {
  // Go: TestAProjectCheckThatReadsFileClassesWaitsForTheInstallOfEveryPackageWithATestProbe
  const all = plannedFor(probeProject(t));
  for (const id of ["quality.size", "quality.suppressions", "quality.clones"]) {
    for (const p of executionsOf(all, id)) {
      assert.deepEqual(waitsOf(p), [".", "api"], id);
    }
  }
});

test("a package Check that reads File classes waits for its own install only", (t) => {
  // Go: TestAPackageCheckThatReadsFileClassesWaitsForItsOwnInstallOnly
  const all = plannedFor(probeProject(t));
  const got = new Map<string, string[]>();
  for (const p of executionsOf(all, "types.javascript")) {
    got.set(p.context.package?.path ?? "", waitsOf(p));
  }
  assert.deepEqual(got.get("."), ["."]);
  assert.deepEqual(got.get("api"), ["api"]);
  for (const path of ["docs", "pnpm", "unsupported"]) {
    assert.deepEqual(got.get(path), [], path);
  }
});

test("Checks that do not read File classes do not wait", (t) => {
  // Go: TestChecksThatDoNotReadFileClassesDoNotWait
  const all = plannedFor(probeProject(t));
  for (const id of [
    "syntax.parse",
    "package.manifest",
    "security.secrets",
    "lint.existing",
    "repository.dockerfile",
    "package.install",
  ]) {
    for (const p of executionsOf(all, id)) {
      assert.deepEqual(p.waits, [], id);
    }
  }
});

test("an install that a File class Check waits for runs even when it is not selected", (t) => {
  // Go: TestAnInstallThatAFileClassCheckWaitsForRunsEvenWhenItIsNotSelected
  const all = plannedFor(probeProject(t), "quality.size");
  const ran = executionsOf(all, "package.install").filter(runnable);
  assert.deepEqual(sortStrings(ran.map((p) => p.context.package?.path ?? "")), [
    ".",
    "api",
  ]);
  for (const p of ran) {
    assert.ok(
      p.prerequisite,
      `the install of ${p.context.path} runs as a prerequisite`,
    );
  }
});

test("a waited install that did not complete does not block the Check", (t) => {
  // Go: TestAWaitedInstallThatDidNotCompleteDoesNotBlockTheCheck
  const all = plannedFor(probeProject(t));
  const size = executionsOf(all, "quality.size")[0];
  const install = size?.waits[0];
  assert.ok(size !== undefined && install !== undefined);
  const r = runState(t);
  r.finish(
    install,
    execResult(install, newExecution({ status: StatusInfrastructureError })),
  );
  assert.equal(blockedByPrerequisite(r, size), null);
});

test("the secret scan is planned as a prerequisite of redaction when it is not selected", (t) => {
  const all = plannedFor(probeProject(t), "package.manifest");
  const [secrets] = executionsOf(all, "security.secrets");
  assert.ok(
    secrets?.deselected === true && secrets.prerequisite && runnable(secrets),
  );
  for (const p of executionsOf(all, "syntax.parse")) {
    assert.ok(p.deselected && !p.prerequisite && !runnable(p));
  }
});

// Prerequisites and ordering with Checks made for the test (Go: the
// mechanics behind prerequisites_test.go, flaky_test.go and
// unhandled_rejections_test.go; the real Checks' links are their tickets').

test("needs and follows make a deselected Check a prerequisite, orderedAfter does not", () => {
  const install = planned({
    key: "x1",
    entry: entry("package.install"),
    check: fakeCheck({ status: "completed" }),
    deselected: true,
  });
  const suite = planned({
    key: "x2",
    entry: entry("tests.existing"),
    check: fakeCheck({ status: "completed" }),
    deselected: true,
  });
  const flaky = planned({
    key: "x3",
    entry: entry("tests.flaky"),
    check: fakeCheck(
      { status: "completed" },
      {
        prerequisites: () => ["package.install"],
        runsAfter: () => ["tests.existing"],
      },
    ),
  });
  const strict = planned({
    key: "x4",
    entry: entry("runtime.unhandled-rejections"),
    check: fakeCheck(
      { status: "completed" },
      {
        orderedAfter: () => ["tests.coverage"],
      },
    ),
  });
  const coverage = planned({
    key: "x5",
    entry: entry("tests.coverage"),
    check: fakeCheck({ status: "completed" }),
    deselected: true,
  });
  resolvePrerequisites([install, suite, flaky, strict, coverage]);
  assert.deepEqual(flaky.needs, [install]);
  assert.deepEqual(flaky.follows, [suite]);
  assert.deepEqual(strict.orderedAfter, [coverage]);
  assert.ok(install.prerequisite && suite.prerequisite);
  assert.ok(!coverage.prerequisite, "orderedAfter never makes a Check run");
});

test("the scheduler waits for what a job needs, waits for, follows and is ordered after", () => {
  const a = planned({ key: "x1", check: fakeCheck({ status: "completed" }) });
  const b = planned({ key: "x2", check: fakeCheck({ status: "completed" }) });
  const c = planned({ key: "x3", check: fakeCheck({ status: "completed" }) });
  const notAJob = planned({
    key: "x4",
    check: fakeCheck({ status: "completed" }),
  });
  c.follows = [a];
  c.orderedAfter = [b, notAJob];
  const jobs: Job[] = [c, a, b].map((p, i) => ({
    index: i,
    p,
    needsDocker: false,
    after: [],
  }));
  linkAfter(jobs);
  assert.deepEqual(jobs[0]?.after, [1, 2]);
  assert.deepEqual(jobs[1]?.after, []);
});

function jobFor(check: string, docker: boolean, ...needs: Planned[]): Job {
  const p = planned({
    entry: entry(check),
    check: fakeCheck({ status: "completed" }),
    needs,
  });
  return { index: 0, p, needsDocker: docker, after: [] };
}

test("installs that suites wait for go first, then the suites, then the rest", () => {
  // Go: TestInstallsThatSuitesWaitForGoFirstThenTheSuitesThenTheRest,
  // TestFlakyRunsWithTheSuitesAheadOfStaticChecks... (the order part)
  const secrets = jobFor("security.secrets", false);
  const syntax = jobFor("syntax.parse", true);
  const install = jobFor("package.install", true);
  const tree = jobFor("deps.tree", true, install.p);
  const suite = jobFor("tests.existing", true, install.p);
  const lint = jobFor("lint.existing", true);
  const flaky = jobFor("tests.flaky", true, install.p);
  const jobs = [secrets, syntax, install, suite, lint, tree, flaky];
  orderJobs(jobs);
  assert.deepEqual(
    jobs.map((j) => j.p.entry.id),
    [
      "security.secrets",
      "package.install",
      "tests.existing",
      "tests.flaky",
      "syntax.parse",
      "lint.existing",
      "deps.tree",
    ],
  );
});

test("an install no suite waits for keeps its Catalog place", () => {
  // Go: TestAnInstallNoSuiteWaitsForKeepsItsCatalogPlace
  const jobs = [
    jobFor("syntax.parse", true),
    jobFor("package.install", true),
    jobFor("lint.existing", true),
  ];
  orderJobs(jobs);
  assert.deepEqual(
    jobs.map((j) => j.p.entry.id),
    ["syntax.parse", "package.install", "lint.existing"],
  );
});
