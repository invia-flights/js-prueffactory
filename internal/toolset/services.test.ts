import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ServiceCPUs,
  ServiceFamilies,
  serviceFamilyNamed,
  serviceFamilyOf,
  ServiceMemoryMB,
} from "./services.ts";

test("every Service family has one pinned image and its own probe", () => {
  const want = [
    "valkey",
    "redis",
    "postgres",
    "mysql",
    "mariadb",
    "mongodb",
    "rabbitmq",
  ];
  assert.deepEqual(
    ServiceFamilies.map((f) => f.name),
    want,
  );
  for (const f of ServiceFamilies) {
    assert.match(f.image.digest, /^sha256:[0-9a-f]{64}$/, f.name);
    assert.ok(f.image.tag !== "" && f.image.repo !== "", f.name);
    assert.ok(
      f.probe.length > 0 && f.version !== "" && f.repos.length > 0,
      f.name,
    );
  }
});

test("a Service family is found by the repository of its official image", () => {
  const cases: Record<string, string> = {
    "valkey/valkey": "valkey",
    valkey: "valkey",
    redis: "redis",
    postgres: "postgres",
    mysql: "mysql",
    mariadb: "mariadb",
    mongo: "mongodb",
    rabbitmq: "rabbitmq",
  };
  for (const [repo, family] of Object.entries(cases)) {
    assert.equal(serviceFamilyOf(repo)?.name, family, repo);
  }
  for (const repo of ["nginx", "bitnami/redis", "redis/redis-stack", ""]) {
    assert.equal(serviceFamilyOf(repo), undefined, repo);
  }
  assert.equal(serviceFamilyNamed("mongodb")?.repos[0], "mongo");
});

test("Services get one CPU and one gigabyte", () => {
  assert.equal(ServiceCPUs, 1);
  assert.equal(ServiceMemoryMB, 1024);
});
