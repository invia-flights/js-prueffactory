import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { lookup } from "../checks/catalog.ts";
import { SecretsCheckID } from "../checks/security_secrets.ts";
import { type ComposeService, Project } from "../discovery/discovery.ts";
import { Logger } from "../progress/progress.ts";
import { EnvRule } from "../redact/redact.ts";
import {
  type ExecStatus,
  StatusCompleted,
  StatusInfrastructureError,
  StatusNotStarted,
  StatusToolError,
} from "../resultset/types.ts";
import {
  newExecution,
  newFinding,
  newLocation,
  newMetric,
  newService,
  newSet,
} from "../resultset/zero.ts";
import { InvalidReportError } from "../writer/writer.ts";
import {
  entry,
  fakeCheck,
  Lines,
  planned,
  runState,
} from "./engine.testutil.ts";
import { type ExecResult, execResult, newExec } from "./execution.ts";
import {
  collectServiceSecrets,
  explainInvalid,
  redactionOutcome,
  redactSet,
  takeSecretScan,
} from "./redaction.ts";

// The engine's side of redaction (Go: redaction_test.go).

const testSecret = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA"; // made up

function scanResult(prereq: boolean, status: ExecStatus): ExecResult {
  const p = planned({
    entry: entry(SecretsCheckID),
    check: fakeCheck({ status: StatusCompleted }),
    deselected: prereq,
    prerequisite: prereq,
  });
  const e = newExec(p);
  e.status = status;
  return execResult(p, e, {
    redact: [testSecret],
    findings: [newFinding({ id: "f1" })],
    metrics: [newMetric({ id: "m1" })],
  });
}

function withLog(t: TestContext) {
  const lines = new Lines();
  const r = runState(t, { log: new Logger(lines) });
  return { r, lines };
}

test("a deselected secret scan still feeds redaction but reports nothing", (t) => {
  // Go: TestADeselectedSecretScanStillFeedsRedactionButReportsNothing
  const { r } = withLog(t);
  const got = takeSecretScan(r, scanResult(true, StatusCompleted));
  assert.ok(!got.exec.selected);
  assert.equal(got.exec.status, StatusNotStarted);
  assert.deepEqual([got.findings, got.metrics], [[], []]);
  assert.equal(got.exec.reason_code, "deselected");
  assert.deepEqual(r.prerequisites, [SecretsCheckID]);
  assert.ok(!r.redactText("x " + testSecret).includes(testSecret));
});

test("a selected secret scan keeps its result", (t) => {
  // Go: TestASelectedSecretScanKeepsItsResult
  const { r } = withLog(t);
  const res = scanResult(false, StatusCompleted);
  assert.equal(takeSecretScan(r, res), res);
  assert.deepEqual(r.prerequisites, []);
});

test("other Checks are not touched by the secret hook", (t) => {
  // Go: TestOtherChecksAreNotTouchedByTheSecretHook
  const { r } = withLog(t);
  const p = planned({ check: fakeCheck({ status: StatusCompleted }) });
  const res = execResult(p, newExec(p), { redact: [testSecret] });
  assert.equal(takeSecretScan(r, res), res);
  assert.equal(r.redactor.len(), 0);
});

test("redaction outcome", () => {
  // Go: TestRedactionOutcome, TestAnIncompleteRedactionReasonNamesTheRule
  assert.deepEqual(
    redactionOutcome(
      { seen: true, status: StatusCompleted, reason: "" },
      "",
      3,
    ),
    { applied: true, count: 3, reason: null },
  );
  const failed = redactionOutcome(
    { seen: true, status: StatusToolError, reason: "" },
    "gitleaks exited with 1",
    1,
  );
  assert.ok(!failed.applied && failed.count === 1);
  assert.match(failed.reason ?? "", /tool_error.*gitleaks exited with 1/);
  const none = redactionOutcome(
    { seen: false, status: StatusNotStarted, reason: "" },
    "",
    0,
  );
  assert.ok(!none.applied);
  assert.match(none.reason ?? "", /look like secrets/);
});

test("a failed scan warns on stderr and leaves redaction not applied", (t) => {
  // Go: TestAFailedScanWarnsOnStderrAndLeavesRedactionNotApplied
  const { r, lines } = withLog(t);
  const p = planned({
    entry: entry(SecretsCheckID),
    check: fakeCheck({ status: StatusCompleted }),
  });
  takeSecretScan(
    r,
    execResult(
      p,
      newExecution({
        status: StatusInfrastructureError,
        reason: "docker said " + testSecret,
      }),
      { redact: [testSecret] },
    ),
  );
  const set = newSet();
  redactSet(r, set);
  const red = set.report_completeness.redaction;
  assert.ok(!red.applied);
  assert.match(red.reason ?? "", /infrastructure_error/);
  assert.ok(!(red.reason ?? "").includes(testSecret));
  assert.ok(!lines.text.includes(testSecret));
  assert.match(lines.text, /warning: secret redaction is incomplete/);
});

function service(fields: Partial<ComposeService>): ComposeService {
  return {
    name: "",
    file: "compose.yaml",
    declared: "",
    family: "",
    notStarted: null,
    env: null,
    unresolved: [],
    versionDiffers: false,
    definedIn: "compose.yaml",
    build: false,
    command: null,
    entrypoint: null,
    dependsOn: [],
    ...fields,
  };
}

function projectWithEnv(): Project {
  const p = new Project("/demo");
  p.dotEnv = new Map([
    ["GREETING", "hello"],
    ["DB_HOST", "db.internal.example"],
    ["DB_PASSWORD", "pw-for-tests"],
  ]);
  p.services = [
    service({
      name: "billing",
      family: "postgres",
      env: new Map([
        ["POSTGRES_PASSWORD", "pw-for-tests"],
        ["POSTGRES_DB", "billing"],
        ["GREETING", "hello"],
      ]),
    }),
  ];
  return p;
}

test("only env values that look like secrets are redacted", (t) => {
  // Go: TestOnlyEnvValuesThatLookLikeSecretsAreRedacted
  const { r } = withLog(t);
  collectServiceSecrets(r, projectWithEnv());
  const set = newSet({
    services: [
      newService({
        family: "postgres",
        compose_service: "billing",
        reason: "billing db said hello with pw-for-tests",
      }),
    ],
    findings: [
      newFinding({
        title: "hello pw-for-tests",
        locations: [newLocation({ path: "src/hello/pw-for-tests.js" })],
      }),
    ],
  });
  redactSet(r, set);
  assert.equal(
    set.services[0]?.reason,
    "billing db said hello with [REDACTED]",
  );
  assert.equal(set.services[0].compose_service, "billing");
  assert.equal(set.findings[0]?.title, "hello [REDACTED]");
  assert.equal(set.findings[0].locations[0]?.path, "src/hello/pw-for-tests.js");
  assert.equal(
    r.redactText("raw log hello pw-for-tests"),
    "raw log hello [REDACTED]",
  );
});

test("the Report names the env rule and what it left readable", (t) => {
  // Go: TestTheReportNamesTheEnvRuleAndWhatItLeftReadable
  const { r } = withLog(t);
  collectServiceSecrets(r, projectWithEnv());
  const set = newSet();
  redactSet(r, set);
  const got = set.limitations.filter(
    (l) => l.reason_code === "env_values_left_readable",
  );
  assert.equal(got.length, 1);
  const m = got[0]?.message ?? "";
  assert.ok(m.includes(EnvRule));
  for (const name of ["GREETING", "DB_HOST", "POSTGRES_DB"]) {
    assert.ok(m.includes(name), name);
  }
  for (const no of ["pw-for-tests", "DB_PASSWORD", "POSTGRES_PASSWORD"]) {
    assert.ok(!m.includes(no), no);
  }
});

test("a placeholder under a secret name stays readable and the Limitation says why", (t) => {
  // Go: TestAPlaceholderUnderASecretNameStaysReadableAndTheLimitationSaysWhy
  const { r } = withLog(t);
  const proj = new Project("/demo");
  proj.dotEnv = new Map([
    ["SOME_SECRET_KEY", "empty"],
    ["STORE_TOKEN", testSecret],
  ]);
  collectServiceSecrets(r, proj);
  const set = newSet({
    findings: [
      newFinding({ title: "answers an empty list with " + testSecret }),
    ],
  });
  redactSet(r, set);
  assert.equal(set.findings[0]?.title, "answers an empty list with [REDACTED]");
  const message =
    set.limitations.find((l) => l.reason_code === "env_values_left_readable")
      ?.message ?? "";
  assert.ok(
    message.includes("placeholder") && message.includes("SOME_SECRET_KEY"),
  );
  assert.ok(!message.includes("STORE_TOKEN"));
});

test("no Limitation when the rule left nothing readable", (t) => {
  // Go: TestNoLimitationWhenTheRuleLeftNothingReadable
  const { r } = withLog(t);
  const proj = new Project("/demo");
  proj.dotEnv = new Map([["DB_PASSWORD", "pw-for-tests"]]);
  collectServiceSecrets(r, proj);
  const set = newSet();
  redactSet(r, set);
  assert.deepEqual(set.limitations, []);
});

test("an invalid Report names the rules that rewrote its fields", (t) => {
  // Go: TestAnInvalidReportNamesTheRulesThatRewroteItsFields
  const { r } = withLog(t);
  const proj = new Project("/demo");
  proj.dotEnv = new Map([["DB_PASSWORD", "pw-for-tests"]]);
  collectServiceSecrets(r, proj);
  takeSecretScan(r, scanResult(false, StatusCompleted));
  r.redactor.addFrom(".npmrc", "madeup-npm-token");
  const set = newSet({
    findings: [
      newFinding({
        title: "pw-for-tests",
        message: testSecret + " and madeup-npm-token",
      }),
    ],
  });
  redactSet(r, set);
  const err = new InvalidReportError(
    ["/findings/0/title: wrong", "/findings/0/message: wrong"],
    "/out/report.invalid.json",
  );
  explainInvalid(r, err);
  for (const want of [
    ".env env-secret-name (variable DB_PASSWORD)",
    "gitleaks",
    ".npmrc",
    "/findings/0/title",
    "/findings/0/message",
  ]) {
    assert.ok(err.message.includes(want), want);
  }
  for (const secret of ["pw-for-tests", testSecret, "madeup-npm-token"]) {
    assert.ok(!err.message.includes(secret));
  }
});

test("the secret scan's entry is in the Catalog", () => {
  assert.equal(lookup(SecretsCheckID)?.scope, "project");
});
