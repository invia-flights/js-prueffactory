import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Kubeconform,
  KubernetesSchemaFolder,
  KubernetesSchemas,
  schemaFileName,
} from "./kubeconform.ts";
import { tableLines } from "./toolset.ts";

test("kubeconform is pinned by the digest of its multi-arch index", () => {
  assert.match(Kubeconform.image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Kubeconform.image.tag.endsWith(Kubeconform.version));
});

test("the schema table has the fixed kinds of one Kubernetes version with checksums", () => {
  const names = new Set<string>();
  for (const f of KubernetesSchemas) {
    names.add(schemaFileName(f));
    assert.match(f.sha256, /^[0-9a-f]{64}$/, schemaFileName(f));
    assert.ok(f.raw.includes(`/${KubernetesSchemaFolder}/`), f.raw);
    assert.ok(f.raw.startsWith("https://"), f.raw);
  }
  const kinds = [
    "deployment-apps-v1",
    "statefulset-apps-v1",
    "daemonset-apps-v1",
    "replicaset-apps-v1",
    "pod-v1",
    "job-batch-v1",
    "cronjob-batch-v1",
    "service-v1",
    "ingress-networking-v1",
    "configmap-v1",
    "secret-v1",
    "serviceaccount-v1",
    "role-rbac-v1",
    "rolebinding-rbac-v1",
    "clusterrole-rbac-v1",
    "clusterrolebinding-rbac-v1",
    "horizontalpodautoscaler-autoscaling-v2",
    "poddisruptionbudget-policy-v1",
    "networkpolicy-networking-v1",
    "persistentvolumeclaim-v1",
    "namespace-v1",
  ];
  for (const k of kinds) {
    assert.ok(names.has(k + ".json"), `no schema for ${k}`);
  }
  assert.equal(names.size, KubernetesSchemas.length);
});

test("every schema checksum is part of the toolset version", () => {
  const line = tableLines().find((l) => l.startsWith("kubernetes-schemas="));
  assert.ok(line);
  for (const f of KubernetesSchemas) {
    assert.ok(line.includes(f.sha256), schemaFileName(f));
  }
});
