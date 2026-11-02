import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Applicable } from "../resultset/types.ts";
import { impl, projectContext, tree } from "./checks.testutil.ts";
import { kubernetesManifests } from "./kubernetes_manifests.ts";
import { maxProjectFileBytes } from "./readcap.ts";

const podManifest = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n";
const v2Chart = "apiVersion: v2\nname: app\nversion: 0.1.0\n";

test("plain manifests are YAML files with a top-level string apiVersion and kind", (t) => {
  const proj = tree(t, {
    "k8s/deploy.yaml": podManifest,
    "k8s/more.yml": "# two documents\n---\nreplicas: 1\n---\n" + podManifest,
    "k8s/ordered.yaml": "kind: Pod\napiVersion: v1\n",
    "k8s/no-kind.yaml": "apiVersion: v1\nmetadata: {name: x}\n",
    "k8s/no-version.yaml": "kind: Pod\n",
    "k8s/number-kind.yaml": "apiVersion: v1\nkind: 5\n",
    "k8s/nested.yaml": "spec:\n  apiVersion: v1\n  kind: Pod\n",
    "k8s/list.yaml": "- apiVersion: v1\n  kind: Pod\n",
    "k8s/values.yaml": "replicas: 2\nimage: nginx\n",
    "k8s/broken.yaml": "apiVersion: v1\nkind: Pod\n  bad: [\n",
    "k8s/readme.md": podManifest,
    "k8s/manifest.yaml.txt": podManifest,
    "weird [x]/a b.yaml": podManifest,
    "templates/x.yaml": podManifest, // not in a Helm chart
  });
  const [got, tooLarge] = kubernetesManifests(proj);
  assert.deepEqual(got, [
    "k8s/deploy.yaml",
    "k8s/more.yml",
    "k8s/ordered.yaml",
    "templates/x.yaml",
    "weird [x]/a b.yaml",
  ]);
  assert.deepEqual(tooLarge, []);
});

test("manifests in Helm templates, Test data, Build output and node_modules are left out", (t) => {
  const proj = tree(t, {
    "chart/Chart.yaml": v2Chart,
    "chart/templates/deployment.yaml":
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n",
    "chart/templates/sub/pod.yaml": podManifest,
    "chart/charts/dep/Chart.yaml": v2Chart,
    "chart/charts/dep/templates/a.yaml": podManifest,
    "chart/crds/crd.yaml":
      "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n",
    "test/fixtures/bad.yaml": podManifest,
    "dist/out.yaml": podManifest,
    "node_modules/dep/k8s.yaml": podManifest,
    "deploy/pod.yaml": podManifest,
  });
  assert.deepEqual(kubernetesManifests(proj)[0], [
    "chart/crds/crd.yaml",
    "deploy/pod.yaml",
  ]);
});

test("a huge manifest is named and not read", (t) => {
  const proj = tree(t, {
    "big.yaml": podManifest + "# " + "x".repeat(maxProjectFileBytes) + "\n",
    "ok.yaml": podManifest,
  });
  assert.deepEqual(kubernetesManifests(proj), [["ok.yaml"], ["big.yaml"]]);
});

describe("repository.kubernetes applies to a chart or a plain manifest and nothing else", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["nothing", { "package.json": "{}" }, false],
    ["a chart", { "c/Chart.yaml": v2Chart }, true],
    ["manifest", { "k/pod.yaml": podManifest }, true],
    ["only a values file", { "k/values.yaml": "a: 1\n" }, false],
  ];
  for (const [name, files, want] of cases) {
    test(name, (t) => {
      const proj = tree(t, files);
      const [got, reason] = impl("repository.kubernetes").applicability(
        proj,
        projectContext(proj),
      );
      assert.equal(got === Applicable, want, `${got} (${reason})`);
      if (!want) {
        assert.notEqual(reason, "");
      }
    });
  }
});
