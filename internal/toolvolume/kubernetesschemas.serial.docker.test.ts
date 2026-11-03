// Go: kubernetesschemas_docker_test.go. These tests fill a real schema volume
// from the network. Every test uses its own cache kind, so it never touches
// the volume of a real Run, and removes it. The last test reads the real
// volume, which the Go build fills, and changes nothing in it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { type Driver, LabelCache, NetworkNone } from "../docker/driver.ts";
import { docker, never, realDriver } from "../docker/realdocker.testutil.ts";
import { Alpine } from "../toolset/helm.ts";
import {
  KubernetesSchemaFolder,
  KubernetesSchemas,
} from "../toolset/kubeconform.ts";
import { imageRef } from "../toolset/toolset.ts";
import {
  ensureKubernetesSchemas,
  type KubernetesSchemasConfig,
  KubernetesSchemaMountPath,
  kubernetesKind,
} from "./kubernetesschemas.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

const folder = KubernetesSchemaMountPath + "/" + KubernetesSchemaFolder;

/** testKind is a cache kind no real Run uses; its volume is removed after the test. */
function testKind(t: TestContext): string {
  const kind = "t17x" + randomBytes(6).toString("hex");
  t.after(() => {
    docker("volume", "rm", "--force", "jspf-cache-" + kind);
  });
  return kind;
}

async function schemaConfig(
  t: TestContext,
  kind: string,
): Promise<KubernetesSchemasConfig & { d: Driver }> {
  const { d } = await realDriver(t, "k8s-schemas");
  await d.pull(never, imageRef(Alpine));
  return { d, docker: d, cacheDir: tempDir(t), kind, helper: imageRef(Alpine) };
}

/** inVolume runs a shell script in the volume, read-only, and returns its output and exit code. */
async function inVolume(
  d: Driver,
  volume: string,
  script: string,
): Promise<[string, number]> {
  const res = await d.runContainer(never, {
    name: "probe-" + randomBytes(3).toString("hex"),
    image: imageRef(Alpine),
    network: NetworkNone,
    mounts: [{ volume, path: KubernetesSchemaMountPath, readOnly: true }],
    cmd: ["sh", "-c", script],
  });
  return [res.stdout.toString(), res.exitCode];
}

test("the Kubernetes schemas are fetched once and verified before use", async (t) => {
  const kind = testKind(t);
  const cfg = await schemaConfig(t, kind);

  const first = await ensureKubernetesSchemas(never, cfg);
  assert.deepEqual(first, { name: "jspf-cache-" + kind, fetched: true });
  assert.equal(
    await cfg.d.volumeLabel(never, first.name, LabelCache),
    kind,
    "the volume must carry its cache label to survive the Run",
  );
  const [out, code] = await inVolume(cfg.d, first.name, `ls ${folder} | wc -l`);
  assert.equal(code, 0);
  assert.equal(out.trim(), String(KubernetesSchemas.length));

  const second = await ensureKubernetesSchemas(never, cfg);
  assert.deepEqual(second, { name: first.name, fetched: false });
});

test("a file that no longer matches its checksum is fetched again", async (t) => {
  const kind = testKind(t);
  const cfg = await schemaConfig(t, kind);
  const first = await ensureKubernetesSchemas(never, cfg);

  // Damage one file from outside, with the volume mounted writable.
  const damage = await cfg.d.runContainer(never, {
    name: "damage",
    image: imageRef(Alpine),
    network: NetworkNone,
    mounts: [{ volume: first.name, path: KubernetesSchemaMountPath }],
    cmd: ["sh", "-c", `echo tampered > ${folder}/pod-v1.json`],
  });
  assert.equal(damage.exitCode, 0);

  const again = await ensureKubernetesSchemas(never, cfg);
  assert.equal(again.fetched, true, "pod-v1.json was changed");
  const [, code] = await inVolume(
    cfg.d,
    again.name,
    `cd ${folder} && grep -q tampered pod-v1.json`,
  );
  assert.notEqual(code, 0, "the tampered file is still there");
});

test("a download that does not match the checksum is never moved into place", async (t) => {
  const kind = testKind(t);
  const cfg = await schemaConfig(t, kind);
  const files = KubernetesSchemas.map((f, i) =>
    i === 1 ? { ...f, sha256: "0".repeat(64) } : f,
  );

  await assert.rejects(
    ensureKubernetesSchemas(never, { ...cfg, files }),
    (err: Error) => {
      assert.match(
        err.message,
        /^a Kubernetes schema does not match its pinned checksum: .*JSPF_SCHEMA_CHECKSUM_MISMATCH/,
      );
      return true;
    },
  );
  const [, code] = await inVolume(
    cfg.d,
    "jspf-cache-" + kind,
    `test -e ${folder}`,
  );
  assert.notEqual(code, 0, "an unverified download is in the schema folder");
});

// User story 26: the Go build's schema volume is reused as it is. With
// JSPF_GO_ORACLE naming the frozen Go binary, a Go Run fills the volume
// first; without it, the test needs a volume an earlier Go Run left.
test("the schema volume the Go build filled is reused without a new fetch", async (t) => {
  const name = "jspf-cache-" + kubernetesKind();
  const oracle = process.env.JSPF_GO_ORACLE ?? "";
  if (oracle !== "") {
    const project = tempDir(t);
    cpSync(
      new URL("../../testdata/projects/ci-files/k8s", import.meta.url),
      join(project, "k8s"),
      { recursive: true },
    );
    const go = spawnSync(
      oracle,
      [
        "test",
        project,
        "--only",
        "repository.kubernetes",
        "--output-dir",
        tempDir(t),
      ],
      { encoding: "utf8" },
    );
    assert.ok(go.status === 0 || go.status === 1, go.stderr);
  }
  const label = docker(
    "volume",
    "inspect",
    "--format",
    `{{index .Labels "${LabelCache}"}}`,
    name,
  );
  if (label.status !== 0) {
    t.skip(
      `no ${name} on this daemon; set JSPF_GO_ORACLE to let the Go build fill it`,
    );
    return;
  }
  assert.equal(label.stdout.trim(), kubernetesKind());

  const { d } = await realDriver(t, "k8s-schemas-go");
  await d.pull(never, imageRef(Alpine));
  const got = await ensureKubernetesSchemas(never, {
    docker: d,
    cacheDir: tempDir(t),
    helper: imageRef(Alpine),
  });
  assert.deepEqual(got, { name, fetched: false });
});
