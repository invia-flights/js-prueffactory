// Init services: a compose service the Run does not start that prepares a
// Service the Run does start (a migration, a seed) with the project's own
// image. Discovery only reads the files; the Suites it marks are tested with
// the Run (see the project init-service).
import assert from "node:assert/strict";
import { test } from "node:test";

import { project } from "./discovery.testutil.ts";
import type { InitService, Project } from "./discovery.ts";

// initNames are the names of the Init services of the project, sorted.
function initNames(p: Project): string[] {
  return p.initServices.map((s) => s.name);
}

function initOf(p: Project, name: string): InitService {
  const s = p.initServices.find((x) => x.name === name);
  assert.ok(s, `${name} is no Init service; have ${initNames(p).join(", ")}`);
  return s;
}

const postgres = "  postgres:\n    image: postgres:16\n";

test("a service with a build section that depends on a started Service is an Init service", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": `services:
${postgres}  migrate:
    build: .
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  const s = initOf(p, "migrate");
  assert.deepEqual(s.prepares, ["postgres"]);
  assert.deepEqual(s.criteria, ["build_section"]);
  assert.equal(s.command, "./migrate.sh");
  assert.equal(s.file, "docker-compose.yml");
  assert.deepEqual(initNames(p), ["migrate"]);
});

test("a service that names the image of a service with a build section is an Init service", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": `services:
${postgres}  api:
    build: .
    image: registry.example.invalid/team/svc:1.4
    command: ["./serve-api.sh"]
  migrate:
    image: registry.example.invalid/team/svc:1.4
    command: ["./migrate.sh"]
    depends_on: [postgres]
  other:
    image: registry.example.invalid/team/other:1
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), ["migrate"]);
  assert.deepEqual(initOf(p, "migrate").criteria, ["image_of_build_service"]);
});

test("an image without a tag is the same image as its latest tag", () => {
  const p = project({
    "docker-compose.yml": `services:
${postgres}  api:
    build: .
    image: registry.example.invalid/team/svc
    command: ["./serve-api.sh"]
  migrate:
    image: registry.example.invalid/team/svc:latest
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), ["migrate"]);
});

test("a service that names the image of the service running a package's start command is an Init service", () => {
  const p = project({
    "package.json": '{"scripts": {"start": "node server.js"}}',
    "docker-compose.yml": `services:
${postgres}  api:
    image: registry.example.invalid/team/svc:1.4
    command: npm start
    depends_on: [postgres]
  migrate:
    image: registry.example.invalid/team/svc:1.4
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  assert.deepEqual(
    initNames(p),
    ["migrate"],
    "the service that runs the start command is the application, not an Init service",
  );
  assert.deepEqual(initOf(p, "migrate").criteria, ["image_of_start_service"]);
});

test("the service that runs the package's main file is the application as well", () => {
  const p = project({
    "package.json": '{"main": "src/server.js"}',
    "src/server.js": "",
    "docker-compose.yml": `services:
${postgres}  api:
    image: registry.example.invalid/team/svc:1
    command: ["node", "./src/server.js"]
    depends_on: [postgres]
  migrate:
    image: registry.example.invalid/team/svc:1
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), ["migrate"]);
  assert.deepEqual(initOf(p, "migrate").criteria, ["image_of_start_service"]);
});

test("a command that runs an npm script of a package is an Init service whatever the image", () => {
  const p = project({
    "package.json": '{"scripts": {"migrate": "knex migrate:latest"}}',
    "docker-compose.yml": `services:
${postgres}  migrate:
    image: registry.example.invalid/team/unrelated:1
    command: npm run migrate
    depends_on: [postgres]
  runscript:
    image: registry.example.invalid/team/unrelated:2
    command: ["npm", "run-script", "--silent", "migrate", "--", "--all"]
    depends_on: [postgres]
  entry:
    image: registry.example.invalid/team/unrelated:3
    entrypoint: ["npm", "run"]
    command: migrate
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), ["entry", "migrate", "runscript"]);
  for (const name of initNames(p)) {
    const s = initOf(p, name);
    assert.deepEqual(s.criteria, ["package_command"], name);
    assert.equal(s.package, ".", name);
  }
  assert.equal(initOf(p, "entry").command, "npm run migrate");
});

test("a command that runs a node file of a package is an Init service", () => {
  const p = project({
    "package.json": "{}",
    "scripts/migrate.js": "",
    "api/package.json": "{}",
    "api/db/seed.cjs": "",
    "docker-compose.yml": `services:
${postgres}  relative:
    image: registry.example.invalid/team/unrelated:1
    command: node ./scripts/migrate.js
    depends_on: [postgres]
  absolute:
    image: registry.example.invalid/team/unrelated:2
    command: ["node", "--require", "dotenv/config", "/usr/src/app/db/seed.cjs"]
    depends_on: [postgres]
  elsewhere:
    image: registry.example.invalid/team/unrelated:3
    command: node scripts/does-not-exist.js
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), ["absolute", "relative"]);
  assert.deepEqual(initOf(p, "relative").criteria, ["package_command"]);
  assert.equal(initOf(p, "relative").package, ".");
  assert.equal(initOf(p, "absolute").package, "api");
});

test("a command that names a script no package has does not make the image the project's own", () => {
  const p = project({
    "package.json": '{"scripts": {"start": "node server.js"}}',
    "docker-compose.yml": `services:
${postgres}  migrate:
    image: registry.example.invalid/team/unrelated:1
    command: npm run migrate
    depends_on: [postgres]
  inline:
    image: registry.example.invalid/team/unrelated:1
    command: ["node", "-e", "require('./migrate.js')"]
    depends_on: [postgres]
  shell:
    image: registry.example.invalid/team/unrelated:1
    command: sh -c "npm run migrate"
    depends_on: [postgres]
  noshell:
    image: registry.example.invalid/team/unrelated:1
    command: npm run migrate && npm run seed
    depends_on: [postgres]
`,
  });
  assert.deepEqual(initNames(p), []);
});

test("depends_on is read in list form and in map form", () => {
  const p = project({
    "docker-compose.yml": `services:
  postgres:
    image: postgres:16
  redis:
    image: valkey/valkey:8.1-alpine
  listed:
    build: .
    command: ["./a.sh"]
    depends_on:
      - redis
      - postgres
  mapped:
    build: .
    command: ["./b.sh"]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
`,
  });
  assert.deepEqual(initOf(p, "listed").prepares, ["postgres", "redis"]);
  assert.deepEqual(initOf(p, "mapped").prepares, ["postgres", "redis"]);
});

test("a one-off service that does not depend on a Service the Run starts is no Init service", () => {
  const p = project({
    "package.json": '{"scripts": {"migrate": "node m.js"}}',
    "docker-compose.yml": `services:
${postgres}  oneoff:
    build: .
    command: npm run migrate
  waits:
    build: .
    command: npm run migrate
    depends_on: [proxy, oneoff, waits]
  proxy:
    image: nginx:1.27
`,
  });
  assert.deepEqual(initNames(p), []);
});

test("the application is no Init service, however the compose file starts it", () => {
  const p = project({
    "package.json": '{"scripts": {"start": "node server.js", "dev": "x"}}',
    "docker-compose.yml": `services:
  postgres:
    image: postgres:16
  app:
    build: .
    depends_on: [postgres]
  web:
    build: .
    command: npm run dev
    depends_on: [postgres]
  prod:
    build: .
    command: npm run start:prod
    depends_on: [postgres]
`,
  });
  assert.deepEqual(
    initNames(p),
    ["prod"],
    "the Dockerfile's own command, npm start and npm run dev start the service; a script this package does not have is not known to",
  );
});

test("the compose files are merged before the detection", () => {
  const p = project({
    "docker-compose.yml": `services:
${postgres}  migrate:
    build: .
`,
    "docker-compose.override.yml": `services:
  migrate:
    command: ["./migrate.sh"]
    depends_on: [postgres]
`,
  });
  const s = initOf(p, "migrate");
  assert.equal(s.file, "docker-compose.yml");
  assert.equal(s.command, "./migrate.sh");
});
