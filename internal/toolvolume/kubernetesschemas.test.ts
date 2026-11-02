// Go: kubernetesschemas_test.go.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KubernetesSchemas,
  type KubernetesSchemaFile,
  schemaFileName,
} from "../toolset/kubeconform.ts";
import {
  KubernetesSchemaMountPath,
  kubernetesKind,
  kubernetesScripts,
} from "./kubernetesschemas.ts";

test("the fetch script checks every file before it moves the folder into place", () => {
  const [sums, script] = kubernetesScripts(KubernetesSchemas);
  for (const f of KubernetesSchemas) {
    assert.ok(
      sums.includes(`${f.sha256}  ${schemaFileName(f)}\n`),
      `the checksum list lacks ${schemaFileName(f)}`,
    );
    assert.ok(
      script.includes(`'${f.raw}'`),
      `the script does not fetch ${f.raw}`,
    );
  }
  const check = script.indexOf("sha256sum -c");
  const move = script.indexOf("mv ");
  assert.ok(
    check >= 0 && move > check,
    `the checksums must be checked before the move:\n${script}`,
  );
});

test("the fetch script and checksum list are the Go build's, byte for byte", () => {
  const [first] = KubernetesSchemas;
  assert.ok(first);
  const [sums, script] = kubernetesScripts([first]);
  assert.equal(
    sums,
    "92b7a333a49124f5300095d3e7786ca2038b7d6e602c309f73e90631377e4b0a  deployment-apps-v1.json\n",
  );
  assert.equal(
    script,
    "set -e; rm -rf /k8s-schemas/.staging && mkdir -p /k8s-schemas/.staging && cd /k8s-schemas/.staging && " +
      `wget -q -O 'deployment-apps-v1.json' '${first.raw}' && ` +
      '{ sha256sum -c /jspf/schemas.sha256 >/dev/null 2>&1 || { echo "JSPF_SCHEMA_CHECKSUM_MISMATCH: a downloaded schema does not match its pinned checksum" >&2; exit 1; }; } && ' +
      "rm -rf /k8s-schemas/v1.34.1-standalone-strict && mv /k8s-schemas/.staging /k8s-schemas/v1.34.1-standalone-strict",
  );
});

test("an unusable schema entry never reaches the script", () => {
  const good = KubernetesSchemas[0];
  assert.ok(good);
  const bad: Record<string, KubernetesSchemaFile> = {
    "a quote in the address": {
      raw: "https://example.test/a'b.json",
      sha256: good.sha256,
    },
    "plain http": { raw: "http://example.test/a.json", sha256: good.sha256 },
    "a space in the address": {
      raw: "https://example.test/a b.json",
      sha256: good.sha256,
    },
    "a checksum with a newline": { raw: good.raw, sha256: good.sha256 + "\n" },
  };
  for (const [name, f] of Object.entries(bad)) {
    assert.throws(
      () => kubernetesScripts([f]),
      /is not usable/,
      `${name} was accepted`,
    );
  }
  assert.throws(() => kubernetesScripts([]), {
    message: "toolvolume: the Kubernetes schema table is empty",
  });
  assert.throws(() => kubernetesScripts([bad["plain http"] ?? good]), {
    message:
      'toolvolume: the Kubernetes schema "http://example.test/a.json" is not usable',
  });
});

test("the schema volume keeps the Go build's cache kind, so either build reuses it", () => {
  assert.equal(kubernetesKind(), "kubernetes-schemas-1-34-1");
  assert.equal(KubernetesSchemaMountPath, "/k8s-schemas");
});
