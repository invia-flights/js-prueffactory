// Seam A without Docker: list-checks shows the compose services of the
// project, and which of them are Init services: not started, and preparing a
// Service the Run does start.
import assert from "node:assert/strict";
import { test } from "node:test";

import { call } from "./cli.testutil.ts";
import {
  listChecksJSON,
  noDockerEnv,
  projectWith,
  testdataProject,
} from "./listchecks.testutil.ts";

test("list-checks lists the Init service of init-service as not started, with the Service it prepares", async (t) => {
  const l = await listChecksJSON(
    t,
    testdataProject("init-service"),
    "--format",
    "json",
  );

  assert.deepEqual(
    l.services.map((s) => [s.name, s.started]),
    [
      ["migrate", false],
      ["postgres", true],
    ],
  );
  const [migrate, postgres] = l.services;
  assert.ok(migrate && postgres);
  assert.equal(migrate.file, "docker-compose.yml");
  assert.equal(migrate.family, "");
  assert.ok(migrate.reason.includes("build section"), migrate.reason);
  assert.deepEqual(migrate.init_service, {
    command: "npm run migrate",
    prepares: ["postgres"],
    criteria: ["build_section", "package_command"],
  });
  assert.equal(postgres.family, "postgres");
  assert.equal(postgres.reason, "");
  assert.equal(postgres.init_service, null);
});

test("list-checks lists the Init service in the Markdown table too", async (t) => {
  const r = await call(
    noDockerEnv(t),
    "list-checks",
    testdataProject("init-service"),
  );

  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.split("\n");
  const at = rows.indexOf("Compose services:");
  assert.ok(at >= 0, "the table of compose services is missing");
  const table = rows.slice(at).join("\n");
  const migrate = rows.find((l) => l.startsWith("| `migrate` |")) ?? "";
  assert.ok(table.includes(migrate) && migrate !== "", table);
  for (const want of [
    "not started",
    "Init service",
    "`npm run migrate`",
    "`postgres`",
  ]) {
    assert.ok(migrate.includes(want), `${want} is not in: ${migrate}`);
  }
  const postgres = rows.find((l) => l.startsWith("| `postgres` |")) ?? "";
  assert.ok(postgres.includes("started"), postgres);
  assert.ok(!postgres.includes("Init service"), postgres);
});

test("list-checks lists no Init service for a one-off service that prepares nothing", async (t) => {
  const dir = projectWith(t, {
    "package.json": '{"scripts": {"migrate": "node m.js"}}',
    "docker-compose.yml": `services:
  postgres:
    image: postgres:17-alpine
  oneoff:
    build: .
    command: npm run migrate
`,
  });

  const l = await listChecksJSON(t, dir, "--format", "json");

  const oneoff = l.services.find((s) => s.name === "oneoff");
  assert.ok(oneoff);
  assert.equal(oneoff.started, false);
  assert.equal(oneoff.init_service, null);
});

test("list-checks without compose files has no table of compose services", async (t) => {
  const dir = projectWith(t, { "package.json": "{}" });

  const l = await listChecksJSON(t, dir, "--format", "json");
  const r = await call(noDockerEnv(t), "list-checks", dir);

  assert.deepEqual(l.services, []);
  assert.ok(!r.stdout.includes("Compose services:"));
});
