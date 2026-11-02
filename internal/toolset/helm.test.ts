import assert from "node:assert/strict";
import { test } from "node:test";

import { Helm, HelmRunner } from "./helm.ts";

test("Helm 3.22 is pinned with checksums for arm64 and amd64", () => {
  assert.ok(Helm.version.startsWith("3.22."), Helm.version);
  assert.equal(Helm.license, "Apache-2.0");
  for (const arch of ["amd64", "arm64"]) {
    const d = Helm.downloads.get(arch);
    assert.ok(d, `no download for ${arch}`);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      d.url,
      `https://get.helm.sh/helm-v${Helm.version}-linux-${arch}.tar.gz`,
    );
  }
  assert.equal(Helm.downloads.size, 2);
});

test("Helm runs in the pinned official Alpine image", () => {
  const img = HelmRunner.image;
  assert.equal(img.repo, "alpine");
  assert.match(img.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(HelmRunner.name, "helm");
  assert.equal(HelmRunner.version, Helm.version);
});
