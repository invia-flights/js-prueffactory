import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { atPath } from "../resultset/resultsettest/scored.testutil.ts";
import { partTable, withProjectTool } from "./benchmark.testutil.ts";

// Expected scores are worked out by hand from S = 100 * 2^(-x / x50), x50 = 1.

// Go: TestTheKubernetesPartCountsInvalidResources (the cases),
// TestTheKubernetesPartIsDroppedWithoutManifests (the last test).
describe("the Kubernetes part counts invalid resources", () => {
  const c = "repository.kubernetes";
  partTable(
    "kubernetes",
    c,
    { label: "Kubernetes", x50: 1, unit: "resources" },
    [
      {
        name: "every resource is valid",
        build: () => undefined,
        raw: 0,
        want: 100,
      },
      {
        name: "one invalid resource",
        build: (p) => {
          p.add(c, "kubernetes.invalid", true, atPath("k8s/deploy.yaml"));
        },
        raw: 1,
        want: 50,
      },
      {
        name: "two invalid resources in one file count twice",
        build: (p) => {
          p.add(c, "kubernetes.invalid", true, atPath("k8s/all.yaml"));
          p.add(c, "kubernetes.invalid", true, atPath("k8s/all.yaml"));
        },
        raw: 2,
        want: 25,
      },
      {
        name: "notes do not count",
        build: (p) => {
          p.add(c, "kubernetes.error", false, atPath("k8s/deploy.yaml"));
        },
        raw: 0,
        want: 100,
      },
    ],
  );
});

// Go: TestTheKubernetesSchemaVersionIsPartOfTheFingerprint.
test("the Kubernetes schema version is part of the fingerprint", () => {
  const none = withProjectTool(null);
  const a = withProjectTool({
    name: "kubernetes-schemas",
    version: "1.34.1",
    digest: null,
  });
  const b = withProjectTool({
    name: "kubernetes-schemas",
    version: "1.35.0",
    digest: null,
  });
  assert.deepEqual(
    [none, a, b].map((f) => f.fields.kubernetes_schema_version),
    [null, "1.34.1", "1.35.0"],
  );
  assert.equal(
    new Set([none.hash, a.hash, b.hash]).size,
    3,
    "the Kubernetes version should change the fingerprint hash",
  );
});
