// A package whose test environment points at a compose Service the Run does
// not start (an unknown family, a private registry, a build section) is
// marked: tests that need it will fail for reasons outside the project. The
// check is a heuristic over env files and Test code, read as text.
import assert from "node:assert/strict";
import { test } from "node:test";

import { project } from "./discovery.testutil.ts";
import type { Project, ServiceRef } from "./discovery.ts";

const composeWithMinio = `services:
  redis:
    image: valkey/valkey:8.1-alpine
  minio:
    image: quay.io/minio/minio:latest
  app:
    build: .
`;

function refsOf(p: Project): ServiceRef[] {
  const root = p.packages.find((x) => x.path === ".");
  assert.ok(root, "no root package");
  return root.serviceRefs;
}

test("an env file URL host naming a Service that is not started marks the package", () => {
  const p = project({
    "package.json": '{"scripts":{"test":"mocha"}}',
    "docker-compose.yml": composeWithMinio,
    "test/.test.env":
      "PORT=1\nTRANSLATION_HOST=http://minio:9000/translations\n",
  });
  assert.deepEqual(refsOf(p), [
    { service: "minio", file: "test/.test.env", line: 2 },
  ]);
});

test("a Service the Run starts is never a reference", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    ".env": "REDIS_URL=redis://redis:6379\n",
  });
  assert.deepEqual(refsOf(p), []);
});

test("only a whole host name counts", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    ".env":
      "A=http://minio-seed:9000\nB=http://minio.example.com/x\nC=see://minio2/\nD=http://xminio:1\n",
  });
  assert.deepEqual(refsOf(p), []);
});

test("an exact env value naming a Service counts", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    "config/test.env": '# comment\nexport S3_HOST="minio"\n',
  });
  assert.deepEqual(refsOf(p), [
    { service: "minio", file: "config/test.env", line: 2 },
  ]);
});

test("Test code naming a Service as a URL host counts", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    "test/s3.test.js": "const url = 'http://minio:9000/x'\n",
  });
  assert.deepEqual(refsOf(p), [
    { service: "minio", file: "test/s3.test.js", line: 1 },
  ]);
});

test("Source code and installed packages are not searched", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    "src/client.js": "const url = 'http://minio:9000/x'\n",
    "node_modules/x/config.env": "A=http://minio:9000\n",
    "node_modules/x/test/index.js": "http://minio:9000",
  });
  assert.deepEqual(refsOf(p), []);
});

test("env files at any depth belong to their nearest package", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    "packages/api/package.json": "{}",
    "packages/api/.env.test": "S3=http://minio:9000\n",
  });
  assert.deepEqual(refsOf(p), []);
  const api = p.packages.find((x) => x.path === "packages/api");
  assert.deepEqual(
    api?.serviceRefs.map((r) => r.file),
    ["packages/api/.env.test"],
  );
});

test("a Service with a build section is also recognised", () => {
  const p = project({
    "package.json": "{}",
    "docker-compose.yml": composeWithMinio,
    ".env": "API=http://app:3000/\n",
  });
  assert.deepEqual(
    refsOf(p).map((r) => r.service),
    ["app"],
  );
});
