import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { apply as applyBenchmark } from "../benchmark/benchmark.ts";
import {
  type ComposeService,
  discover,
  Project,
  type TestFile,
} from "../discovery/discovery.ts";
import { withCancel, withDeadline } from "../gocompat/context.ts";
import {
  atPath,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  type Finding,
  IsolationConfirmed,
  IsolationNotIsolated,
  IsolationNotProbed,
  ServiceInfrastructureError,
  ServiceNotStarted,
  ServiceStarted,
  StatusBudgetExhausted,
  StatusCancelled,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
  TestFailed,
  TestNeverRun,
  TestPassed,
} from "../resultset/types.ts";
import {
  newArtifact,
  newEvidence,
  newFinding,
  newLocation,
  newService,
  newTestCase,
} from "../resultset/zero.ts";
import { producer } from "./assemble.ts";
import {
  entry,
  executeOne,
  fakeCheck,
  planned,
  runState,
  tempDir,
  writeTree,
} from "./engine.testutil.ts";
import { execResult, newExec } from "./execution.ts";
import { readIsolationProbe } from "./isolation.ts";
import { registryDataDate } from "./registrydate.ts";
import { reportServices } from "./services.ts";
import { markFileClasses } from "./testcode.ts";

// One execution as the engine runs it, and the parts of the Report that the
// engine assembles (Go: artifact_links_test.go, testcases_test.go,
// flaky_test.go (keeps status), testcode_test.go, services_test.go,
// registry_date_test.go, isolation_test.go).

test("Evidence keeps its link to an artifact the Check keyed", async (t) => {
  // Go: TestEvidenceKeepsItsLinkToAnArtifactTheCheckKeyed
  const check = fakeCheck({
    status: StatusCompleted,
    artifacts: [
      newArtifact({
        id: "log",
        path: "artifacts/x/log.txt",
        content: Buffer.from("log"),
      }),
      newArtifact({
        id: "diff-one",
        path: "artifacts/x/one.diff",
        content: Buffer.from("diff"),
      }),
    ],
    findings: [
      newFinding({
        title: "linked",
        evidence: [
          newEvidence({ kind: "diff", text: "diff", artifact_id: "diff-one" }),
          newEvidence({
            kind: "diff",
            text: "other",
            artifact_id: "diff-nowhere",
          }),
          newEvidence({ kind: "text", text: "plain" }),
        ],
      }),
    ],
  });
  const p = planned({ key: "x9", entry: entry("schema.drift"), check });
  const res = await executeOne(runState(t), p);
  assert.deepEqual(
    res.artifacts.map((a) => [a.id, a.check_id]),
    [
      ["x9-a1", "schema.drift"],
      ["x9-a2", "schema.drift"],
    ],
  );
  assert.deepEqual(res.exec.artifact_ids, ["x9-a1", "x9-a2"]);
  assert.deepEqual(
    res.findings[0]?.evidence.map((e) => e.artifact_id),
    ["x9-a2", null, null],
  );
});

function suiteCheck() {
  return fakeCheck({
    status: StatusCompleted,
    findings: [
      newFinding({ title: "hook", gate: true }),
      newFinding({ title: "test", gate: true }),
    ],
    testCases: [
      {
        testCase: newTestCase({ full_title: "passes", outcome: TestPassed }),
        findings: [],
      },
      {
        testCase: newTestCase({ full_title: "fails", outcome: TestFailed }),
        findings: [1],
      },
      {
        testCase: newTestCase({
          full_title: "never ran",
          outcome: TestNeverRun,
        }),
        findings: [0],
      },
    ],
  });
}

test("test cases of an execution keep their outcomes and point at its Findings", async (t) => {
  // Go: TestTestCasesOfAnExecutionKeepTheirOutcomesAndPointAtItsFindings
  const p = planned({
    key: "x7",
    entry: entry("tests.existing"),
    check: suiteCheck(),
  });
  const res = await executeOne(runState(t), p);
  assert.deepEqual(
    res.testCases.map((tc) => [tc.full_title, tc.execution_id, tc.finding_ids]),
    [
      ["passes", "x7", []],
      ["fails", "x7", [res.findings[1]?.id]],
      ["never ran", "x7", [res.findings[0]?.id]],
    ],
  );
  assert.equal(res.gates, 2);
  assert.equal(res.failure, "hook: ");
});

test("a prerequisite that was not selected reports no test cases, no Findings and says why it failed", async (t) => {
  // Go: TestAPrerequisiteThatWasNotSelectedReportsNoTestCases
  const p = planned({
    key: "x7",
    entry: entry("tests.existing"),
    check: suiteCheck(),
    deselected: true,
    prerequisite: true,
  });
  const res = await executeOne(runState(t), p);
  assert.deepEqual([res.testCases, res.findings], [[], []]);
  assert.equal(res.exec.reason_code, "prerequisite_failed_project");
  assert.match(
    res.exec.reason ?? "",
    /as a prerequisite that was not selected.*hook/,
  );
});

// A Check that watches its own limits keeps its partial status when the
// Budget ends; a cancellation by the user always shows as cancelled.
function limitWatcher(keeps: boolean) {
  return fakeCheck({
    status: StatusPartial,
    reasonCode: "budget_exhausted",
    reason: "the Budget ran out during run 3",
    keepsStatus: keeps,
    findings: [newFinding({ title: "kept" })],
  });
}

async function executeAfterBudget(
  t: TestContext,
  keeps: boolean,
  run: AbortSignal,
) {
  const budget = withDeadline(run, Date.now() - 1000);
  t.after(() => {
    budget.cancel();
  });
  const p = planned({
    key: "x9",
    entry: entry("tests.flaky"),
    check: limitWatcher(keeps),
  });
  return executeOne(runState(t), p, run, budget.signal);
}

test("a Check that watches its own limits keeps its partial status when the Budget ends", async (t) => {
  // Go: TestACheckThatWatchesItsOwnLimitsKeepsItsPartialStatusWhenTheBudgetEnds
  const res = await executeAfterBudget(t, true, withCancel().signal);
  assert.equal(res.exec.status, StatusPartial);
  assert.equal(res.exec.reason_code, "budget_exhausted");
  assert.equal(res.findings.length, 1);
});

test("other Checks that end with the Budget are still reported as budget_exhausted", async (t) => {
  // Go: TestOtherChecksThatEndWithTheBudgetAreStillReportedAsBudgetExhausted
  const res = await executeAfterBudget(t, false, withCancel().signal);
  assert.equal(res.exec.status, StatusBudgetExhausted);
  assert.equal(res.exec.reason, "the Budget ran out");
  assert.equal(res.findings.length, 1);
});

test("a cancelled Run is reported as cancelled even for a Check that keeps its status", async (t) => {
  // Go: TestACancelledRunIsReportedAsCancelledEvenForACheckThatKeepsItsStatus
  const run = withCancel();
  run.cancel();
  const res = await executeAfterBudget(t, true, run.signal);
  assert.equal(res.exec.status, StatusCancelled);
});

test("a Check that throws is a tool_error, not the end of the Run", async (t) => {
  const p = planned({
    check: fakeCheck(() => Promise.reject(new Error("index out of range"))),
  });
  const res = await executeOne(runState(t), p);
  assert.equal(res.exec.status, StatusToolError);
  assert.equal(res.exec.reason_code, "internal_error");
  assert.equal(res.exec.reason, "the Check panicked: index out of range");
});

test("the tools and the npm version a Check reports go into its Context, once and in name order", async (t) => {
  const tool = (name: string) => ({ name, version: "1", digest: "sha256:x" });
  const p = planned({
    check: fakeCheck({
      status: StatusCompleted,
      toolRefs: [tool("zz"), tool("aa"), tool("zz")],
      npmVersion: "10.9.0",
    }),
  });
  await executeOne(runState(t), p);
  assert.deepEqual(
    p.context.tools.map((x) => x.name),
    ["aa", "zz"],
  );
  assert.equal(p.context.npm_version, "10.9.0");
});

// --- in_test_code (Go: testcode_test.go) ---

function testCodeProject(t: TestContext): Project {
  const root = tempDir(t);
  const files: Record<string, string> = {};
  for (const rel of [
    "package.json",
    "src/index.js",
    "src/a.spec.js",
    "src/fare-ab-test.js",
    "test/helper.js",
    "test/fixtures/creds.json",
    ".env",
    "sub/package.json",
    "sub/lib/b.spec.js",
    "sub/test/c.js",
  ]) {
    files[rel] = "{}\n";
  }
  writeTree(root, files);
  return discover(root);
}

function findingAt(...paths: string[]): Finding {
  return newFinding({
    id: paths[0] ?? "",
    locations: paths.map((path, i) =>
      newLocation({
        role: i === 0 ? "primary" : "related",
        path_base: "project_root",
        path,
      }),
    ),
  });
}

// The probe of the root package found the co-located spec.
const probedSpec: TestFile[] = [
  {
    contextID: "C-0002",
    path: "src/a.spec.js",
    suite: "scripts.test",
    kind: "spec",
  },
];

test("every Finding whose primary location is Test code is marked", (t) => {
  // Go: TestEveryFindingWhosePrimaryLocationIsTestCodeIsMarked
  const findings = [
    findingAt("test/helper.js"),
    findingAt("src/a.spec.js"),
    findingAt("sub/test/c.js"),
    findingAt("lib/gone/test/removed.js"),
    findingAt("src/index.js", "test/helper.js"),
  ];
  markFileClasses(testCodeProject(t), probedSpec, findings);
  assert.deepEqual(
    findings.map((f) => f.in_test_code),
    [true, true, true, true, false],
  );
});

test("Findings outside Test code stay unmarked", (t) => {
  // Go: TestFindingsOutsideTestCodeStayUnmarked
  const findings = [
    findingAt("src/fare-ab-test.js"),
    findingAt("sub/lib/b.spec.js"),
    findingAt("test/fixtures/creds.json"),
    findingAt(".env"),
    newFinding({ id: "no location" }),
    newFinding({
      id: "only a related location",
      locations: [newLocation({ role: "related", path: "test/helper.js" })],
    }),
  ];
  markFileClasses(testCodeProject(t), probedSpec, findings);
  assert.ok(findings.every((f) => !f.in_test_code));
});

test("a flag a Check set itself is never cleared", (t) => {
  // Go: TestAFlagACheckSetItselfIsNeverCleared
  const f = findingAt("src/index.js");
  f.in_test_code = true;
  markFileClasses(testCodeProject(t), [], [f]);
  assert.ok(f.in_test_code);
});

test("a secret in Test code says the value may be made up", (t) => {
  // Go: TestASecretInTestCodeSaysTheValueMayBeMadeUp
  const note = "The file is Test code, so the value may be made up on purpose.";
  const secretAt = (path: string): Finding => {
    const f = findingAt(path);
    f.check_id = "security.secrets";
    f.message = "gitleaks flags a possible secret here.";
    return f;
  };
  const lint = findingAt("test/helper.js");
  lint.check_id = "lint.correctness";
  lint.message = "no-dupe-keys";
  const findings = [
    secretAt("test/helper.js"),
    secretAt("src/a.spec.js"),
    secretAt("src/index.js"),
    secretAt("src/fare-ab-test.js"),
    secretAt(".env"),
    lint,
  ];
  markFileClasses(testCodeProject(t), probedSpec, findings);
  assert.deepEqual(
    findings.map((f) => f.message.endsWith(" " + note)),
    [true, true, false, false, false, false],
  );
  for (const f of findings) {
    assert.ok(f.message.split(note).length <= 2);
  }
});

test("a typed lint hit in a probed spec is Test code and leaves the Typed lint part", (t) => {
  // Go: TestATypedLintHitInAProbedSpecIsTestCodeAndLeavesTheTypedLintPart
  const typedLint = (probed: TestFile[]) => {
    const p = scoredProject();
    p.addExecution("lint.typed", "C-0002");
    p.add(
      "lint.typed",
      "@typescript-eslint/no-floating-promises",
      false,
      atPath("src/index.js"),
    );
    p.add(
      "lint.typed",
      "@typescript-eslint/no-misused-promises",
      false,
      atPath("src/a.spec.js"),
    );
    markFileClasses(testCodeProject(t), probed, p.set.findings);
    const s = p.done();
    applyBenchmark(s);
    return s.benchmark.areas
      .flatMap((a) => a.parts)
      .find((part) => part.id === "typed_lint");
  };
  assert.equal(typedLint(probedSpec)?.raw_value, 1);
  assert.equal(typedLint([])?.raw_value, 2);
});

// --- services (Go: services_test.go) ---

function compose(fields: Partial<ComposeService>): ComposeService {
  return {
    name: "",
    file: "",
    declared: "",
    family: "",
    notStarted: null,
    env: null,
    unresolved: [],
    versionDiffers: false,
    definedIn: "",
    build: false,
    command: null,
    entrypoint: null,
    dependsOn: [],
    ...fields,
  };
}

test("Services of several suites are merged with the worst status", () => {
  // Go: TestServicesOfSeveralSuitesAreMergedWithTheWorstStatus
  const proj = new Project("/demo");
  proj.services = [
    compose({
      name: "redis",
      family: "valkey",
      declared: "valkey/valkey:8.1-alpine",
      file: "docker-compose.yml",
    }),
    compose({
      name: "db",
      family: "postgres",
      declared: "postgres:12",
      file: "compose.yaml",
      versionDiffers: true,
    }),
    compose({
      name: "app",
      declared: "registry.example.com/app:1",
      notStarted: { code: "private_registry", reason: "private registry" },
    }),
    compose({ name: "idle", family: "redis", declared: "redis:8" }),
  ];
  proj.composeProblems = [
    { path: "broken.yml", reason: "it is not valid YAML" },
  ];
  const p = planned({ check: fakeCheck({ status: StatusCompleted }) });
  const e = execResult(p, newExec(p));
  const results = [
    {
      ...e,
      services: [
        newService({
          family: "valkey",
          compose_service: "redis",
          image: "valkey/valkey:8.1-alpine",
          image_digest: "sha256:abc",
          declared_image: "valkey/valkey:8.1-alpine",
          context_ids: ["C-0003"],
          status: ServiceStarted,
        }),
        newService({
          family: "postgres",
          compose_service: "db",
          declared_image: "postgres:12",
          context_ids: ["C-0003"],
          status: ServiceStarted,
        }),
      ],
    },
    {
      ...e,
      services: [
        newService({
          family: "valkey",
          compose_service: "redis",
          declared_image: "valkey/valkey:8.1-alpine",
          context_ids: ["C-0002"],
          status: ServiceInfrastructureError,
          reason: "exited",
        }),
        newService({
          family: "postgres",
          compose_service: "db",
          declared_image: "postgres:12",
          context_ids: ["C-0002"],
          status: ServiceStarted,
        }),
      ],
    },
    e,
  ];
  const [services, limits] = reportServices(results, proj);
  const by = (name: string) => services.find((s) => s.compose_service === name);
  const redis = by("redis");
  assert.equal(redis?.status, ServiceInfrastructureError);
  assert.equal(redis.reason, "exited");
  assert.deepEqual(redis.context_ids, ["C-0002", "C-0003"]);
  assert.equal(redis.image, "valkey/valkey:8.1-alpine");
  assert.equal(by("db")?.status, ServiceStarted);
  assert.equal(by("db")?.context_ids.length, 2);
  const app = by("app");
  assert.deepEqual(
    [app?.status, app?.reason, app?.family, app?.context_ids],
    [ServiceNotStarted, "private registry", "other", []],
  );
  const idle = by("idle");
  assert.equal(idle?.family, "redis");
  assert.match(idle.reason ?? "", /no test suite/);
  assert.deepEqual(
    limits.map((l) => [l.reason_code, l.path]),
    [
      ["service_version_differs", "compose.yaml"],
      ["compose_file_unreadable", "broken.yml"],
    ],
  );
  assert.match(limits[0]?.message ?? "", /postgres:12/);
});

// --- registry data date (Go: registry_date_test.go) ---

test("the Run records the oldest registry fetch as its registry data date", async (t) => {
  // Go: TestTheRunRecordsTheOldestRegistryFetchAsItsRegistryDataDate,
  // TestARunWithoutAnyRegistryFetchHasNoRegistryDataDate
  const r = runState(t);
  const old = new Date(Date.UTC(2026, 9, 27, 9, 0, 0));
  const newer = new Date(old.getTime() + 3_600_000);
  const fetched = (at: Date | null) =>
    executeOne(
      r,
      planned({
        entry: entry("deps.deprecated"),
        check: fakeCheck({ status: StatusCompleted, registryDataDate: at }),
      }),
    );
  const results = [
    await fetched(newer),
    await fetched(old),
    await fetched(null),
  ];
  assert.equal(registryDataDate(results), "2026-10-27T09:00:00Z");
  assert.equal(registryDataDate([await fetched(null)]), null);
});

// --- the isolation probe (Go: isolation_test.go) ---

test("the isolation probe only confirms what it saw fail", () => {
  // Go: TestTheIsolationProbeOnlyConfirmsWhatItSawFail
  const cases: [number, string, string][] = [
    [0, "BLOCKED\n", IsolationConfirmed],
    [0, "CONNECTED\n", IsolationNotIsolated],
    [0, "PROBE_BROKEN\n", IsolationNotProbed],
    [0, "", IsolationNotProbed],
    [127, "", IsolationNotProbed],
    [1, "BLOCKED\n", IsolationNotProbed],
    [0, "BLOCKED\nCONNECTED\n", IsolationNotProbed],
  ];
  for (const [exitCode, out, want] of cases) {
    assert.equal(
      readIsolationProbe({ exitCode, stdout: Buffer.from(out) }),
      want,
      out,
    );
  }
});

test("producer names the package version and no revision when run from the sources", () => {
  // Version is the Go constant at the freeze commit. Sources run directly
  // have no stamped commit, as a Go build without VCS information had none.
  assert.deepEqual(producer(), {
    name: "js-prueffactory",
    version: "0.1.0-dev",
    vcs_revision: null,
  });
});
