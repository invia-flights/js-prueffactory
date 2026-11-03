// repository.kubernetes end to end (Go: kubernetes_docker_test.go), and a
// project with plain manifests only, which needs no Helm.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";
import {
  executionOf,
  findingsOf,
  fullReport,
  errorsByPath,
  limitationsOf,
} from "./repository.testutil.ts";

test("invalid Kubernetes resources are errors without a Gate and custom resources are a Limitation", async (t) => {
  // Go: TestInvalidKubernetesResourcesFailTheRunAndCustomResourcesAreALimitation
  const original = copyProject(t, "ci-files");
  const before = treeFingerprint(original);

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.kubernetes",
  ]);

  const s = fullReport(r);
  const e = executionOf(s, "repository.kubernetes");
  assert.equal(r.code, 0, `${e.reason ?? ""}\n${r.stderr}`);
  assert.deepEqual(
    [e.status, e.outcome, e.context_id, e.gate],
    ["completed", "observations_only", "C-0001", 0],
  );
  assert.deepEqual(e.tool, {
    name: "kubeconform",
    version: "0.8.0",
    exit_code: 1,
  });

  const gates = errorsByPath(s, "repository.kubernetes");
  assert.equal(
    gates.size,
    2,
    "one in the plain manifest and one for the chart",
  );
  const plain = gates.get("k8s/deployment.yaml");
  assert.match(plain?.title ?? "", /Deployment\/api/);
  assert.equal(plain?.rule_id, "kubernetes.invalid");
  assert.equal(plain.evidence[0]?.trust, "untrusted_data");
  assert.match(plain.evidence[0].text, /replicas/);

  // The chart renders the same invalid Deployment with both values files:
  // one Finding that names the chart, the template and both values files.
  const chart = gates.get("charts/web/templates/deployment.yaml");
  assert.match(chart?.title ?? "", /Deployment\/jspf-web/);
  for (const want of [
    "charts/web",
    "templates/deployment.yaml",
    "default values",
    "values-prod.yaml",
  ]) {
    assert.ok(
      chart?.message.includes(want),
      `${chart?.message ?? ""} lacks ${want}`,
    );
  }

  // The custom resource is not validated, and says so once.
  const limitations = limitationsOf(s, "repository.kubernetes");
  assert.equal(limitations.length, 1, JSON.stringify(limitations));
  assert.equal(limitations[0]?.reason_code, "kinds_not_validated");
  assert.match(limitations[0].message, /cert-manager\.io\/v1 Certificate: 1/);
  assert.equal(s.summary.gates, 0);

  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});

test("Helm and Kubernetes together render the charts for both and keep their own results", async (t) => {
  // Go: TestHelmAndKubernetesTogetherRenderTheChartsForBothAndKeepTheirOwnResults
  const original = copyProject(t, "ci-files");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.helm,repository.kubernetes",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = fullReport(r);
  // repository.helm has no Finding: the chart renders.
  const helm = executionOf(s, "repository.helm");
  assert.deepEqual([helm.status, helm.gate], ["completed", 0]);
  const kube = executionOf(s, "repository.kubernetes");
  assert.deepEqual([kube.status, kube.gate], ["completed", 0]);
  assert.equal(errorsByPath(s, "repository.kubernetes").size, 2);
  assertNothingLeft(r);
});

test("a chart that Helm cannot render is left out with a Limitation and no Gate", async (t) => {
  // Go: TestAChartThatHelmCannotRenderIsLeftOutWithALimitationAndNoGate
  const original = copyProject(t, "repository-files");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.helm,repository.kubernetes",
  ]);

  const s = fullReport(r);
  // repository.helm reports the chart that does not render with values-broken.yaml, as an error without a Gate.
  assert.equal(executionOf(s, "repository.helm").gate, 0, r.stderr);
  assert.ok(errorsByPath(s, "repository.helm").size > 0, r.stderr);
  const kube = executionOf(s, "repository.kubernetes");
  assert.deepEqual([kube.status, kube.gate], ["completed", 0]);
  assert.ok(
    limitationsOf(s, "repository.kubernetes").some(
      (l) =>
        l.reason_code === "chart_not_rendered" &&
        l.message.includes("values-broken.yaml") &&
        l.message.includes("repository.helm"),
    ),
    JSON.stringify(s.limitations),
  );
  // The chart still renders with its default values, and that is valid.
  assert.deepEqual(findingsOf(s, "repository.kubernetes"), []);
  assertNothingLeft(r);
});

test("the Benchmark has a Kubernetes part and the Kubernetes version in the fingerprint", async (t) => {
  // Go: TestTheBenchmarkHasAKubernetesPartAndTheKubernetesVersionInTheFingerprint
  const original = copyProject(t, "ci-files");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "repository.kubernetes",
  ]);

  const s = fullReport(r);
  const part = s.benchmark?.areas
    .flatMap((a) => a.parts)
    .find((p) => p.id === "kubernetes");
  assert.equal(part?.state, "measured", r.stderr);
  assert.equal(part.raw_value, 2, "two invalid resources");
  assert.equal(
    s.benchmark?.fingerprint.fields.kubernetes_schema_version,
    "1.34.1",
  );
});

test("plain manifests are validated without Helm and without the toolset volume", async (t) => {
  // No Go counterpart: the charts are removed, so only the schema volume and
  // kubeconform take part.
  const original = copyProject(t, "ci-files");
  rmSync(join(original, "charts"), { recursive: true });

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "repository.kubernetes",
  ]);

  const s = fullReport(r);
  const e = executionOf(s, "repository.kubernetes");
  assert.deepEqual(
    [r.code, e.status, e.gate],
    [0, "completed", 0],
    `${e.reason ?? ""}\n${r.stderr}`,
  );
  assert.deepEqual(
    [...errorsByPath(s, "repository.kubernetes").keys()],
    ["k8s/deployment.yaml"],
  );
  const limitations = limitationsOf(s, "repository.kubernetes");
  assert.deepEqual(
    limitations.map((l) => l.reason_code),
    ["kinds_not_validated"],
  );
  assertNothingLeft(r);
});
