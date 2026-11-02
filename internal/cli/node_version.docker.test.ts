// Seam A tests of the Node version and image variant with a real Docker
// daemon: the project's tests run on the version and variant discovery chose
// (Go: node_version_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { nodeImage, VariantAlpine, VariantDebian } from "../toolset/node.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  counts,
  findingsOf,
  full,
  inventoryOf,
  oneExecution,
  packageContext,
  writeFiles,
} from "./suites.testutil.ts";

const existing = "tests.existing";

/** nodeVersionTest is a Mocha test that passes only on the given Node major. */
function nodeVersionTest(major: string): Record<string, string> {
  return {
    "test/node-version.test.js":
      "'use strict';\n\nconst assert = require('node:assert');\n\n" +
      `describe('node', () => {\n  it('runs on Node ${major}', () => {\n` +
      `    assert.strictEqual(process.version.split('.')[0], 'v${major}');\n  });\n});\n`,
  };
}

test("tests run on the Node version of .nvmrc", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, nodeVersionTest("22"));
  writeFiles(original, { ".nvmrc": "v22.3.0\n" });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const n = packageContext(s).node;
  const img = nodeImage(22, VariantDebian);
  assert.ok(n && img, JSON.stringify(n));
  assert.equal(n.version, "22");
  assert.equal(n.source, "nvmrc");
  assert.equal(n.variant, "debian");
  assert.equal(n.image_digest, img.digest);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "passed", "the version test passes only on Node 22");
  assertNothingLeft(r);
});

test("an Alpine Dockerfile runs the tests on Alpine and a missing program is named in the Finding", async (t) => {
  const original = copyProject(t, "alpine-missing-program");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const n = packageContext(s).node;
  const img = nodeImage(22, VariantAlpine);
  assert.ok(n && img, JSON.stringify(n));
  assert.equal(n.version, "22");
  assert.equal(n.source, "dockerfile");
  assert.equal(n.variant, "alpine");
  assert.equal(n.image_digest, img.digest);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, "the one failing test");
  for (const want of [
    "spawn git ENOENT",
    "`git`",
    "missing from the Node 22 alpine image",
  ]) {
    assert.ok(
      fs[0]?.message.includes(want),
      `${fs[0]?.message ?? ""} misses ${want}`,
    );
  }
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 2, run: 2, passed: 1, failed: 1 }),
  );
  assertNothingLeft(r);
});

test("an unsupported Node version starts nothing in the package and says why", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFiles(original, { ".nvmrc": "18\n" });

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "tests.existing,syntax.parse",
  ]);

  const s = full(r);
  assert.equal(
    packageContext(s).node,
    null,
    "no Node for an unsupported version",
  );
  for (const id of ["tests.existing", "syntax.parse"]) {
    const e = oneExecution(s, id);
    assert.equal(e.status, "unsupported", id);
    assert.equal(e.reason_code, "node_version_unsupported", id);
    assert.ok(e.reason?.includes("Node 18"), `${id}: ${String(e.reason)}`);
  }
  assertNothingLeft(r);
});
