import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CatalogVersion } from "../checks/catalog.ts";
import {
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import { SHA } from "../resultset/resultsettest/sample.testutil.ts";
import {
  type Context,
  type Service,
  ServiceStarted,
} from "../resultset/types.ts";
import { fingerprintOf } from "./benchmark.testutil.ts";

function ctx(p: Project, i: number): Context {
  const c = p.set.contexts[i];
  assert.ok(c, `no Context ${String(i)}`);
  return c;
}

function service(digest: string, name = "cache"): Service {
  return {
    family: "valkey",
    compose_service: name,
    image: null,
    image_digest: digest,
    declared_image: "valkey/valkey:8",
    context_ids: [],
    status: ServiceStarted,
    reason: null,
  };
}

// Go: TestTheFingerprintHoldsEverythingThatShapesAScore.
test("the fingerprint holds everything that shapes a score", () => {
  const p = scoredProject();
  ctx(p, 0).tools = [
    { name: "hadolint", version: "2.12.0", digest: "sha256:cd" },
  ];
  p.set.services = [service("sha256:ef")];
  p.set.profiles.catalog_version = "milestone-1";
  p.set.profiles.toolset_version = "toolset-abc";
  const f = fingerprintOf(p).fields;

  assert.equal(f.profile_id, "benchmark-v1-uncalibrated");
  assert.equal(f.catalog_version, "milestone-1");
  assert.equal(f.toolset_version, "toolset-abc");
  // The Node image, the tool image and the Service image.
  assert.deepEqual(
    [...f.image_digests].sort(),
    ["sha256:" + SHA, "sha256:cd", "sha256:ef"].sort(),
  );
  assert.deepEqual(f.eslint_config_hashes, [SHA]);
  assert.deepEqual(f.security_rule_hashes, ["cd" + SHA.slice(2)]);
  assert.equal(f.advisory_database_date, "2026-10-26T03:00:00Z");
  assert.deepEqual(f.runtimes, [
    { node_version: "24.1.0", npm_version: "11.1.0" },
  ]);
});

// Go: TestTheShortHashChangesWithEveryFieldAndOnlyWithThem.
describe("the short hash changes with every field and only with them", () => {
  const base = fingerprintOf(scoredProject());

  test("the hash is 12 hex digits and the same for the same Run", () => {
    assert.match(base.hash, /^[0-9a-f]{12}$/);
    assert.equal(fingerprintOf(scoredProject()).hash, base.hash);
  });

  test("Findings and the Run ID do not change it", () => {
    const same = scoredProject();
    same.add("lint.correctness", "no-undef", false);
    same.add("security.secrets", "generic-api-key", false);
    same.set.run.id = "another-run";
    assert.equal(fingerprintOf(same).hash, base.hash);
  });

  const changes: Record<string, (p: Project) => void> = {
    "toolset version": (p) => {
      p.set.profiles.toolset_version = "other";
    },
    "catalog version": (p) => {
      p.set.profiles.catalog_version = "other";
    },
    "node version": (p) => {
      const node = ctx(p, 1).node;
      assert.ok(node);
      node.version = "22.5.0";
    },
    "node image": (p) => {
      const node = ctx(p, 1).node;
      assert.ok(node);
      node.image_digest = "sha256:ff";
    },
    "npm version": (p) => {
      ctx(p, 1).npm_version = "10.0.0";
    },
    "eslint config": (p) => {
      const t = ctx(p, 1).tools[0];
      assert.ok(t);
      t.digest = "00";
    },
    "security rules": (p) => {
      const t = ctx(p, 1).tools[2];
      assert.ok(t);
      t.digest = "00";
    },
    "advisory data": (p) => {
      const t = ctx(p, 1).tools[1];
      assert.ok(t);
      t.version = "2026-10-27T03:00:00Z";
    },
    "a service image": (p) => {
      p.set.services = [service("sha256:aa", "c")];
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    test(`a different ${name}`, () => {
      const p = scoredProject();
      change(p);
      assert.notEqual(fingerprintOf(p).hash, base.hash);
    });
  }
});

// Go: TestAContextWithoutASupportedNodeVersionAddsNoRuntime.
test("a Context without a supported Node version adds no runtime", () => {
  const p = scoredProject();
  ctx(p, 1).node = null;
  ctx(p, 1).npm_version = null;
  const fp = fingerprintOf(p);
  assert.deepEqual(fp.fields.runtimes, []);
  assert.deepEqual(fp.fields.image_digests, []);
});

// Go: TestTwoContextsWithTheSameRuntimeAreOneRuntime.
test("two Contexts with the same runtime are one runtime", () => {
  const p = scoredProject();
  p.set.contexts.push({ ...ctx(p, 1), id: "C-0003", path: "packages/b" });
  assert.equal(fingerprintOf(p).fields.runtimes.length, 1);
});

// Go: TestAnAdvisoryDatabaseThatWasNeverRecordedIsNull.
test("an advisory database that was never recorded is null", () => {
  const p = scoredProject();
  ctx(p, 1).tools = ctx(p, 1).tools.slice(0, 1);
  assert.equal(fingerprintOf(p).fields.advisory_database_date, null);
});

// Go: TestTheShippedCatalogVersionMakesEveryNewFingerprintDifferFromMilestoneOne.
test("the shipped Catalog version makes every new fingerprint differ from milestone 1", () => {
  assert.equal(CatalogVersion, "milestone-2");
  const withVersion = (v: string) => {
    const p = scoredProject();
    p.set.profiles.catalog_version = v;
    return fingerprintOf(p);
  };
  const now = withVersion(CatalogVersion);
  const before = withVersion("milestone-1");
  assert.equal(now.fields.catalog_version, "milestone-2");
  assert.notEqual(now.hash, before.hash);
});
