// Compose Services: the project's compose files tell which test Services a
// Run starts. Discovery only reads the files, never runs anything.
import assert from "node:assert/strict";
import { test } from "node:test";

import { project } from "./discovery.testutil.ts";
import type { ComposeService, Project } from "./discovery.ts";

function serviceOf(p: Project, name: string): ComposeService {
  const s = p.services.find((x) => x.name === name);
  assert.ok(s, `compose service ${name} not discovered`);
  return s;
}

test("a known image in the compose file is a test Service", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml":
      "services:\n  redis:\n    image: valkey/valkey:8.1-alpine\n",
  });
  const s = serviceOf(p, "redis");
  assert.equal(s.family, "valkey");
  assert.equal(s.notStarted, null);
  assert.equal(s.declared, "valkey/valkey:8.1-alpine");
  assert.equal(s.file, "docker-compose.yml");
});

test("every known family is recognised by its official image name", () => {
  const cases: Record<string, string> = {
    valkey: "valkey/valkey:8.1-alpine",
    redis: "redis:7.2",
    postgres: "docker.io/library/postgres:16",
    mysql: "mysql:8.4",
    mariadb: "mariadb:11.4",
    mongodb: "mongo:7",
    rabbitmq: "rabbitmq:3.13-management",
  };
  for (const [family, image] of Object.entries(cases)) {
    const p = project({
      "compose.yaml": `services:\n  svc:\n    image: ${image}\n`,
    });
    const s = serviceOf(p, "svc");
    assert.equal(s.family, family, image);
    assert.equal(s.notStarted, null, image);
  }
});

test("services that are never started say why", () => {
  const p = project({
    "docker-compose.yml": `services:
  app:
    build: .
    image: valkey/valkey:8
  nodejs:
    image: registry.example.invalid/team/my-service:\${IMAGE_VERSION:-latest}
  cache:
    image: ghcr.io/someone/redis:7
  proxy:
    image: nginx:1.27
  noimage:
    command: [npm, help]
`,
  });
  const want: Record<string, string> = {
    app: "build_section",
    nodejs: "private_registry",
    cache: "private_registry",
    proxy: "unknown_image",
    noimage: "no_image",
  };
  for (const [name, code] of Object.entries(want)) {
    const s = serviceOf(p, name);
    assert.equal(s.family, "", name);
    assert.equal(s.notStarted?.code, code, name);
  }
  assert.equal(
    serviceOf(p, "nodejs").declared,
    "registry.example.invalid/team/my-service:latest",
    "the image interpolated with its default",
  );
});

test("compose files are merged like an override and only the root is read", () => {
  const p = project({
    "docker-compose.yml": `services:
  redis:
    image: valkey/valkey:8.1-alpine
    environment:
      A: base
      B: base
`,
    // Sorted before docker-compose.yml, but an override file still wins.
    "docker-compose.override.yml": `services:
  redis:
    ports: ["6379:6379"]
    environment:
      B: override
`,
    "sub/compose.yml": "services:\n  hidden:\n    image: redis:7\n",
    "docker-compose.txt": "services:\n  text:\n    image: redis:7\n",
    "my-compose.yml": "services:\n  mine:\n    image: redis:7\n",
    "compose.override.yaml": "services:\n  extra:\n    image: postgres:16\n",
    "docker-compose.dev.yml": "services:\n  dev:\n    image: mongo:7\n",
  });
  const s = serviceOf(p, "redis");
  assert.equal(s.family, "valkey");
  assert.ok(s.env);
  assert.equal(s.env.get("A"), "base");
  assert.equal(s.env.get("B"), "override");
  const names = new Set(p.services.map((x) => x.name));
  for (const n of ["redis", "extra", "dev"]) assert.ok(names.has(n), n);
  for (const n of ["hidden", "text", "mine"]) assert.ok(!names.has(n), n);
});

test("the environment is interpolated from the .env file the way compose does it", () => {
  const p = project({
    ".env": `# comment
export PASS=s3cret
USER_NAME="app user"
SINGLE='$not_expanded'
BASE=db
COMBINED=\${BASE}-1
EMPTY=
`,
    "docker-compose.yml": `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${PASS}
      POSTGRES_USER: $USER_NAME
      POSTGRES_DB: \${MISSING:-fallback}
      A: \${EMPTY-unused}
      B: \${EMPTY:-used}
      C: \${PASS:+set}
      D: \${UNSET_VAR+nope}
      E: $\${ESCAPED}
      F: \${SINGLE}
      G: \${COMBINED}
`,
    "compose.yaml": `services:
  other:
    image: mysql:8.4
    environment:
      - MYSQL_ROOT_PASSWORD=\${PASS}
      - PLAIN=value=with=equals
      - FROM_ENV_FILE
`,
  });
  const db = serviceOf(p, "db");
  const want: Record<string, string> = {
    POSTGRES_PASSWORD: "s3cret",
    POSTGRES_USER: "app user",
    POSTGRES_DB: "fallback",
    A: "",
    B: "used",
    C: "set",
    D: "",
    E: "${ESCAPED}",
    F: "$not_expanded",
    G: "db-1",
  };
  for (const [k, v] of Object.entries(want)) {
    assert.equal(db.env?.get(k), v, k);
  }
  assert.deepEqual(db.unresolved, []);
  const other = serviceOf(p, "other");
  assert.ok(other.env);
  assert.equal(other.env.get("MYSQL_ROOT_PASSWORD"), "s3cret");
  assert.equal(other.env.get("PLAIN"), "value=with=equals");
  assert.ok(
    !other.env.has("FROM_ENV_FILE"),
    "a bare name without a value in .env must not be passed",
  );
});

test("a variable that cannot be resolved blocks the service", () => {
  const p = project({
    "docker-compose.yml": `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      OTHER: \${REQUIRED:?must be set}
      FINE: \${DEFAULTED:-x}
`,
  });
  assert.deepEqual(serviceOf(p, "db").unresolved, ["DB_PASSWORD", "REQUIRED"]);
});

test("the host environment never feeds the interpolation", (t) => {
  process.env.JSPF_HOST_SECRET = "from-the-host";
  t.after(() => {
    delete process.env.JSPF_HOST_SECRET;
  });
  const p = project({
    "docker-compose.yml":
      "services:\n  db:\n    image: postgres:16\n    environment:\n      X: ${JSPF_HOST_SECRET}\n",
  });
  const db = serviceOf(p, "db");
  assert.notEqual(db.env?.get("X"), "from-the-host");
  assert.equal(db.unresolved.length, 1);
});

test("a different version than the pinned one is noted", () => {
  const cases: [string, boolean][] = [
    ["valkey/valkey:8.1-alpine", false], // the pinned version
    ["valkey/valkey:8.1.3", false], // a patch release of it: same series
    ["valkey/valkey:8", false],
    ["valkey/valkey", false], // no version asked for
    ["valkey/valkey:latest", false],
    ["valkey/valkey:7.2-alpine", true],
    ["postgres:12", true],
    ["postgres:17-alpine", false],
  ];
  for (const [image, differ] of cases) {
    const p = project({
      "compose.yml": `services:\n  s:\n    image: ${image}\n`,
    });
    assert.equal(serviceOf(p, "s").versionDiffers, differ, image);
  }
});

test("service names that could inject options are never started", () => {
  const p = project({
    "compose.yml":
      'services:\n  "--privileged":\n    image: redis:7\n  "a b":\n    image: redis:7\n  ok_name-1.x:\n    image: redis:7\n',
  });
  for (const name of ["--privileged", "a b"]) {
    assert.equal(serviceOf(p, name).notStarted?.code, "invalid_service_name");
  }
  assert.equal(serviceOf(p, "ok_name-1.x").notStarted, null);
});

test("an unreadable compose file is noted with yaml.v3's first error line", () => {
  const p = project({
    "compose.yml": "services: [this is: not valid",
    "compose.override.yml": "services:\n  redis:\n    image: redis:7\n",
  });
  assert.deepEqual(p.composeProblems, [
    {
      path: "compose.yml",
      reason:
        "it is not valid YAML of the compose format: yaml: line 1: did not find expected ',' or ']'",
    },
  ]);
  assert.equal(
    serviceOf(p, "redis").family,
    "redis",
    "the readable file must still count",
  );
});

test("environment values that are not strings read as Go formats them", () => {
  const p = project({
    "compose.yml": `services:
  db:
    image: postgres:16
    environment:
      INT: 0x1F
      FLOAT: 1e3
      BIG: 18446744073709551616
      SMALL: 1e-7
      BOOL: true
      DATE: 2001-12-14
      OCTAL: 017
      LIST: [a, 1]
      MAP: {b: 2, a: 1}
      INF: .inf
`,
  });
  assert.deepEqual(Object.fromEntries(serviceOf(p, "db").env ?? []), {
    INT: "31",
    FLOAT: "1000",
    BIG: "18446744073709552000",
    SMALL: "0.0000001",
    BOOL: "true",
    DATE: "2001-12-14 00:00:00 +0000 UTC",
    OCTAL: "15",
    LIST: "[a 1]",
    MAP: "map[a:1 b:2]",
    INF: "+Inf",
  });
});
