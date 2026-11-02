// Seam A without Docker: list-checks shows the Node version of every package
// Context, where it came from, the other declared versions and the variant.
import assert from "node:assert/strict";
import { test } from "node:test";

import { call } from "./cli.testutil.ts";
import {
  listChecksJSON,
  noDockerEnv,
  projectWith,
  rowOf,
} from "./listchecks.testutil.ts";

test("list-checks shows the Node version, its source, the variant and the other declared versions", async (t) => {
  const dir = projectWith(t, {
    "package.json": '{"name":"demo","engines":{"node":">=24"}}',
    Dockerfile: "FROM node:22-alpine\n",
    ".nvmrc": "24\n",
    "packages/lib/package.json": '{"name":"lib"}',
  });
  const cs = (await listChecksJSON(t, dir, "--format", "json")).contexts;

  assert.equal(cs.length, 3);
  const [project, root, lib] = cs;
  assert.ok(project && root && lib);
  assert.equal(project.kind, "project");
  assert.equal(project.node, null);
  assert.equal(root.path, ".");
  assert.ok(root.node);
  assert.equal(root.node.version, "22");
  assert.equal(root.node.source, "dockerfile");
  assert.equal(root.node.variant, "alpine");
  assert.deepEqual(root.node.not_checked_versions, [
    "24 (.nvmrc)",
    ">=24 (engines.node)",
  ]);
  assert.ok(root.node.image.includes("@sha256:"), root.node.image);
  assert.ok(lib.node);
  assert.equal(lib.node.version, "24");
  assert.equal(lib.node.source, "default");
  assert.equal(lib.node.variant, "debian");
  // An empty list, not null.
  assert.deepEqual(lib.node.not_checked_versions, []);

  const r = await call(noDockerEnv(t), "list-checks", dir);
  for (const want of ["Node", "22 alpine", "dockerfile", "24 (.nvmrc)"]) {
    assert.ok(r.stdout.includes(want), `markdown misses ${want}`);
  }
});

test("list-checks shows an unsupported Node version and what it blocks", async (t) => {
  const dir = projectWith(t, {
    "package.json":
      '{"name":"demo","scripts":{"test":"mocha"},"devDependencies":{"mocha":"^10"}}',
    "package-lock.json": "{}",
    "index.js": "module.exports = 1;\n",
    ".nvmrc": "18\n",
  });
  const l = await listChecksJSON(t, dir, "--format", "json");
  const pkg = l.contexts[1];
  assert.ok(pkg);
  assert.equal(pkg.node, null);
  assert.ok(pkg.node_unsupported.includes("Node 18"), pkg.node_unsupported);
  assert.ok(
    pkg.node_unsupported.includes("22, 24 and 26"),
    pkg.node_unsupported,
  );
  for (const id of ["package.install", "tests.existing", "syntax.parse"]) {
    const a = rowOf(l, id).applicability;
    assert.equal(a.length, 1, id);
    const reason = a[0]?.reason ?? "";
    assert.ok(reason.startsWith("unsupported: "), id);
    assert.ok(reason.includes("Node 18"), id);
  }
  const r = await call(noDockerEnv(t), "list-checks", dir);
  assert.ok(r.stdout.includes("unsupported") && r.stdout.includes("Node 18"));
});
