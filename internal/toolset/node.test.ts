import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nodeImage,
  nodeVersion,
  SupportedNodeMajors,
  VariantAlpine,
  VariantDebian,
} from "./node.ts";

test("every supported Node major has a pinned image per variant", () => {
  assert.deepEqual(SupportedNodeMajors, [22, 24, 26]);
  const digest = /^sha256:[0-9a-f]{64}$/;
  const seen = new Set<string>();
  for (const major of SupportedNodeMajors) {
    for (const variant of [VariantDebian, VariantAlpine]) {
      const img = nodeImage(major, variant);
      assert.ok(img, `no image for Node ${String(major)} ${variant}`);
      assert.match(img.digest, digest);
      assert.ok(!seen.has(img.digest), `digest ${img.digest} repeated`);
      seen.add(img.digest);
      assert.ok(img.tag.startsWith(`${String(major)}.`), img.tag);
      assert.equal(img.tag.includes("alpine"), variant === VariantAlpine);
    }
  }
  assert.equal(nodeImage(20, VariantDebian), undefined);
});

test("the Node version of an image leaves out the variant suffix", () => {
  assert.equal(nodeVersion(24, VariantAlpine), "24.22.1");
  assert.equal(nodeVersion(24, VariantDebian), "24.22.1");
  assert.equal(nodeVersion(20, VariantDebian), undefined);
});
