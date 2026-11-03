// Seam A tests of network isolation and compose Services with a real Docker
// daemon: the Execution phase has no outbound network, and the tests of a
// suite get fresh Services under their compose names on a network of their own
// (Go: services_docker_test.go, unknown_host_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  executionsOf,
  findingsOf,
  full,
  limitationOf,
  oneExecution,
  serviceNamed,
  writeFiles,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("a test that expects outbound requests to fail passes and isolation is confirmed", async (t) => {
  const original = copyProject(t, "network-egress");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "passed");
  assert.equal(s.summary.test_cases.passed, 2);
  assert.equal(s.summary.network_isolation, "confirmed");
  assert.equal(limitationOf(s, "network_not_isolated"), undefined);
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(md.includes("Network isolation: `confirmed`"), md);
  assert.deepEqual(s.services, [], "the project has no compose file");
  assertNothingLeft(r);
});

test("every Run that starts containers probes the network", async (t) => {
  const original = copyProject(t, "clean-mocha");

  // package.manifest is native, but the secret scan that every Run does
  // starts a container, so the Execution phase begins with the probe.
  const r = await realRun(t, ["test", original, "--only", "package.manifest"]);

  assert.equal(full(r).summary.network_isolation, "confirmed", r.stderr);
  assert.ok(r.stderr.includes("network isolation confirmed"), r.stderr);
  assertNothingLeft(r);
});

test("Valkey starts empty under its compose name for every suite and is gone afterwards", async (t) => {
  const original = copyProject(t, "valkey-service");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const suites = executionsOf(s, existing);
  assert.equal(suites.length, 2, "the root package and packages/second");
  for (const e of suites) {
    assert.equal(e.status, "completed", e.context_id);
    assert.equal(e.outcome, "passed", e.context_id);
  }
  // Both suites write a key and look at the size of the database three
  // seconds later, so a shared Service would show two.
  assert.equal(s.summary.test_cases.passed, 6);
  assert.equal(s.summary.test_cases.failed, 0);

  const redis = serviceNamed(s, "redis");
  assert.equal(redis.family, "valkey");
  assert.equal(redis.status, "started");
  assert.equal(redis.reason, null);
  assert.equal(redis.image, "valkey/valkey:8.1-alpine");
  assert.ok(
    redis.image_digest?.startsWith("sha256:"),
    String(redis.image_digest),
  );
  assert.equal(redis.declared_image, "valkey/valkey:8.1-alpine");
  assert.deepEqual(redis.context_ids, [
    suites[0]?.context_id,
    suites[1]?.context_id,
  ]);
  assert.equal(
    limitationOf(s, "service_version_differs"),
    undefined,
    "the pinned version was declared",
  );

  // The project's own service is listed, with the reason it is not started.
  const app = serviceNamed(s, "nodejs");
  assert.equal(app.status, "not_started");
  assert.equal(app.image, null);
  assert.ok(
    app.reason?.includes("registry.example.invalid"),
    String(app.reason),
  );
  assert.equal(
    app.declared_image,
    "registry.example.invalid/team/valkey-service:latest",
  );
  assert.deepEqual(app.context_ids, []);

  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  assert.ok(md.includes("`redis` (valkey): started"), md);
  // Services and their networks are removed when their suite ends.
  assertNothingLeft(r);
});

test("a different compose version is noted as a Limitation and the pinned image runs", async (t) => {
  const original = copyProject(t, "valkey-service");
  rmSync(join(original, "packages"), { recursive: true, force: true });
  writeFiles(original, {
    "docker-compose.yml":
      "services:\n  redis:\n    image: valkey/valkey:7.2-alpine\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  assert.equal(
    r.code,
    0,
    `findings: ${JSON.stringify(findingsOf(s, existing))}\n${r.stderr}`,
  );
  const l = limitationOf(s, "service_version_differs");
  assert.ok(l, JSON.stringify(s.limitations));
  assert.ok(l.message.includes("valkey/valkey:7.2-alpine"), l.message);
  assert.ok(l.message.includes("8.1-alpine"), l.message);
  const redis = serviceNamed(s, "redis");
  assert.equal(redis.declared_image, "valkey/valkey:7.2-alpine");
  assert.equal(redis.image, "valkey/valkey:8.1-alpine");
  assertNothingLeft(r);
});

test("an unresolved variable blocks the Service and its suites", async (t) => {
  const original = copyProject(t, "valkey-service");
  rmSync(join(original, "packages"), { recursive: true, force: true });
  writeFiles(original, {
    "docker-compose.yml":
      "services:\n  redis:\n    image: valkey/valkey:8.1-alpine\n    environment:\n      PASSWORD: ${DB_PASSWORD}\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "blocked");
  assert.equal(e.reason_code, "service_variable_unresolved");
  assert.ok(e.reason?.includes("DB_PASSWORD"), String(e.reason));
  const redis = serviceNamed(s, "redis");
  assert.equal(redis.status, "blocked");
  assert.ok(redis.reason?.includes("DB_PASSWORD"), String(redis.reason));
  assert.equal(redis.image, null);
  assert.equal(
    r.code,
    2,
    `exit code for a Run that could not run a Check\n${r.stderr}`,
  );
  assertNothingLeft(r);
});

test("a secret from the env file never reaches the Report through a Service log", async (t) => {
  const original = copyProject(t, "valkey-service");
  rmSync(join(original, "packages"), { recursive: true, force: true });
  // initdb rejects the option and prints it, so the Service's log echoes the value.
  writeFiles(original, {
    ".env": "DB_ARGS=hunter2supersecret\n",
    "docker-compose.yml":
      "services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: pw\n      POSTGRES_INITDB_ARGS: ${DB_ARGS}\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "infrastructure_error", r.stderr);
  for (const name of ["report.json", "report.md"]) {
    const data = readFileSync(join(r.reportDir, name), "utf8");
    assert.ok(
      !data.includes("hunter2supersecret"),
      `${name} contains the secret from the .env file`,
    );
  }
  const db = serviceNamed(s, "db");
  assert.ok(
    db.reason?.includes("[REDACTED]"),
    `db = ${JSON.stringify(db)}, want the log tail with the value redacted`,
  );
  assertNothingLeft(r);
});

// A short value is a secret when its name says so (redact.EnvRule): the length
// floor only applies to values under a name that says nothing.
test("a short secret under a secret name is redacted from a Service log too", async (t) => {
  const original = copyProject(t, "valkey-service");
  rmSync(join(original, "packages"), { recursive: true, force: true });
  writeFiles(original, {
    ".env": "DB_SECRET_ARGS=Zq7x\n",
    "docker-compose.yml":
      "services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: pw\n      POSTGRES_INITDB_ARGS: ${DB_SECRET_ARGS}\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const e = oneExecution(full(r), existing);
  assert.equal(e.status, "infrastructure_error", r.stderr);
  for (const name of ["report.json", "report.md"]) {
    const data = readFileSync(join(r.reportDir, name), "utf8");
    assert.ok(!data.includes("Zq7x"), `${name} contains the short secret`);
    assert.ok(data.includes("REDACTED"), `${name} shows no redaction`);
  }
  assertNothingLeft(r);
});

test("a Service that never comes up ends its suite as an infrastructure error", async (t) => {
  const original = copyProject(t, "valkey-service");
  rmSync(join(original, "packages"), { recursive: true, force: true });
  // Postgres refuses to start without a password, so it exits at once.
  writeFiles(original, {
    "docker-compose.yml": "services:\n  db:\n    image: postgres:17-alpine\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "infrastructure_error");
  assert.equal(e.reason_code, "service_not_ready");
  assert.ok(e.reason?.includes("db"), String(e.reason));
  const db = serviceNamed(s, "db");
  assert.equal(db.status, "infrastructure_error");
  assert.notEqual(db.reason, null);
  assert.equal(db.family, "postgres");
  assert.equal(r.code, 2, r.stderr);
  assertNothingLeft(r);
});

// node:test suites get their Services the same way Mocha suites do.
test("a node:test suite gets its compose Service under its compose name", async (t) => {
  const original = copyProject(t, "node-test-service");

  const r = await realRun(t, ["test", original, "--only", existing]);

  const s = full(r);
  assert.equal(
    r.code,
    0,
    `findings: ${JSON.stringify(findingsOf(s, existing))}\n${r.stderr}`,
  );
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "passed");
  assert.equal(e.tool?.name, "node:test");
  assert.equal(s.summary.test_cases.passed, 2);
  assert.equal(s.summary.test_cases.failed, 0);
  const redis = serviceNamed(s, "redis");
  assert.equal(redis.family, "valkey");
  assert.equal(redis.status, "started");
  assert.equal(redis.reason, null);
  assert.deepEqual(redis.context_ids, [e.context_id]);
  assertNothingLeft(r);
});

// A test that talks to a host the Run does not provide fails fast and
// visibly. On the Execution network a lookup of an unknown name takes 5 s by
// default, which is the testdata test's own 5 s timeout; with the resolver
// options every container gets, the test fails with the lookup error instead.
test("a test that requests a host the Run does not provide fails with a lookup error, not a timeout", async (t) => {
  const original = copyProject(t, "unknown-host");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const evidence = (fs[0]?.evidence ?? []).map((e) => e.text + "\n").join("");
  assert.ok(
    evidence.includes("EAI_AGAIN") || evidence.includes("ENOTFOUND"),
    `the Evidence shows no lookup error:\n${evidence}`,
  );
  assert.ok(
    !evidence.includes("Timeout of"),
    `the test ran into its timeout instead of failing the lookup:\n${evidence}`,
  );
  assert.equal(s.summary.test_cases.failed, 1);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "failed");
  assertNothingLeft(r);
});
