import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { project, tempDir } from "./discovery.testutil.ts";
import { type Context, discover, type Package } from "./discovery.ts";

// nodeOf discovers a project and returns the package Context at path.
function nodeOf(
  files: Record<string, string>,
  path: string,
): [Context, Package] {
  const proj = project(files);
  const c = proj.contexts.find((x) => x.package?.path === path);
  assert.ok(c?.package, `no package ${path}`);
  return [c, c.package];
}

test("the Node version comes from the first source that answers", async (t) => {
  const cases: [string, Record<string, string>, string, string, string][] = [
    ["default", { "package.json": "{}" }, "24", "default", "debian"],
    [
      "dockerfile",
      { "package.json": "{}", Dockerfile: "FROM node:22\n" },
      "22",
      "dockerfile",
      "debian",
    ],
    [
      "dockerfile beats nvmrc",
      { "package.json": "{}", Dockerfile: "FROM node:22\n", ".nvmrc": "24\n" },
      "22",
      "dockerfile",
      "debian",
    ],
    [
      "nvmrc",
      { "package.json": "{}", ".nvmrc": "v22.3.0\n" },
      "22",
      "nvmrc",
      "debian",
    ],
    [
      "nvmrc beats node-version",
      { "package.json": "{}", ".nvmrc": "22\n", ".node-version": "24\n" },
      "22",
      "nvmrc",
      "debian",
    ],
    [
      "node-version",
      { "package.json": "{}", ".node-version": "24.1.0" },
      "24",
      "node_version_file",
      "debian",
    ],
    [
      "node-version beats engines",
      { "package.json": '{"engines":{"node":">=22"}}', ".node-version": "22" },
      "22",
      "node_version_file",
      "debian",
    ],
    [
      "engines picks the highest supported major",
      { "package.json": '{"engines":{"node":">=20"}}' },
      "26",
      "engines",
      "debian",
    ],
    [
      "engines range with an upper bound",
      { "package.json": '{"engines":{"node":">=20 <24"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines caret",
      { "package.json": '{"engines":{"node":"^22.1.0"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines with alternatives",
      { "package.json": '{"engines":{"node":"18 || 24"}}' },
      "24",
      "engines",
      "debian",
    ],
    [
      "engines x-range",
      { "package.json": '{"engines":{"node":"22.x"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines tilde",
      { "package.json": '{"engines":{"node":"~24.2"}}' },
      "24",
      "engines",
      "debian",
    ],
    [
      "engines hyphen range",
      { "package.json": '{"engines":{"node":"20.0.0 - 23.9.9"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines less or equal",
      { "package.json": '{"engines":{"node":"<=22"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines less than",
      { "package.json": '{"engines":{"node":"<24"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines operator then space",
      { "package.json": '{"engines":{"node":">= 22.1 < 23"}}' },
      "22",
      "engines",
      "debian",
    ],
    [
      "engines exact version",
      { "package.json": '{"engines":{"node":"24.3.0"}}' },
      "24",
      "engines",
      "debian",
    ],
    [
      "engines star",
      { "package.json": '{"engines":{"node":"*"}}' },
      "26",
      "engines",
      "debian",
    ],
  ];
  for (const [name, files, version, source, variant] of cases) {
    await t.test(name, () => {
      const [c] = nodeOf(files, ".");
      const n = c.node;
      assert.ok(n, "no Node runtime");
      assert.deepEqual(
        [n.version, n.source, n.variant],
        [version, source, variant],
      );
      assert.ok(n.image_digest.startsWith("sha256:"));
      assert.equal(n.image, "node@" + n.image_digest);
    });
  }
});

test("Node version sources that do not answer fall through", async (t) => {
  const cases: Record<string, Record<string, string>> = {
    "alias in nvmrc": { "package.json": "{}", ".nvmrc": "lts/*\n" },
    "garbage in nvmrc": {
      "package.json": "{}",
      ".nvmrc": "22; touch /tmp/x\n",
    },
    "empty nvmrc": { "package.json": "{}", ".nvmrc": "\n\n" },
    "comment-only nvmrc": { "package.json": "{}", ".nvmrc": "# nothing\n" },
    "engines not a string": { "package.json": '{"engines":{"node":22}}' },
    "engines not parseable": {
      "package.json": '{"engines":{"node":"banana"}}',
    },
    "dockerfile without node": {
      "package.json": "{}",
      Dockerfile: "FROM nginx:1.27\n",
    },
    "dockerfile arg tag": {
      "package.json": "{}",
      Dockerfile: "ARG V=22\nFROM node:${V}\n",
    },
    "dockerfile arg tag bare": {
      "package.json": "{}",
      Dockerfile: "ARG V=22\nFROM node:$V-alpine\n",
    },
    "dockerfile lts tag": {
      "package.json": "{}",
      Dockerfile: "FROM node:lts\n",
    },
    "dockerfile in test data": {
      "package.json": "{}",
      "test/fixtures/Dockerfile": "FROM node:22\n",
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    await t.test(name, () => {
      const n = nodeOf(files, ".")[0].node;
      assert.deepEqual(
        [n?.version, n?.source, n?.variant],
        ["24", "default", "debian"],
      );
    });
  }
});

test("the Node version comes from the last node line of a Dockerfile", async (t) => {
  const cases: Record<string, [string, string, string]> = {
    "last of several stages": [
      "FROM node:20 AS build\nRUN x\nFROM node:22-alpine\n",
      "22",
      "alpine",
    ],
    "later non-node stage": [
      "FROM node:22 AS build\nFROM nginx:1.27\nCOPY --from=build /a /b\n",
      "22",
      "debian",
    ],
    "arg line is ignored": [
      "ARG V=18\nFROM node:22-alpine AS a\nFROM node:${V}-alpine\n",
      "22",
      "alpine",
    ],
    "platform flag and as": [
      "FROM --platform=linux/amd64 node:22.3.1-alpine3.20 AS app\n",
      "22",
      "alpine",
    ],
    "lower case": ["from node:22-alpine\n", "22", "alpine"],
    "slim stays on full debian": ["FROM node:22-slim\n", "22", "debian"],
    bookworm: ["FROM node:22-bookworm\n", "22", "debian"],
    "digest after the tag": [
      "FROM node:22-alpine@sha256:" + "a".repeat(64) + "\n",
      "22",
      "alpine",
    ],
    "docker.io path": [
      "FROM docker.io/library/node:22-alpine\n",
      "22",
      "alpine",
    ],
    "continued line": ["FROM \\\n  node:22-alpine\n", "22", "alpine"],
    "comment is not a stage": [
      "# FROM node:18\nFROM node:22\n",
      "22",
      "debian",
    ],
    "windows line endings": [
      "FROM node:22-alpine\r\nRUN x\r\n",
      "22",
      "alpine",
    ],
    "a node:<major> in RUN": [
      "FROM node:22\nRUN echo FROM node:18\n",
      "22",
      "debian",
    ],
  };
  for (const [name, [dockerfile, version, variant]] of Object.entries(cases)) {
    await t.test(name, () => {
      const n = nodeOf({ "package.json": "{}", Dockerfile: dockerfile }, ".")[0]
        .node;
      assert.deepEqual(
        [n?.version, n?.source, n?.variant],
        [version, "dockerfile", variant],
      );
    });
  }
});

test("Dockerfile names that count", () => {
  for (const name of [
    "Dockerfile",
    "Dockerfile.prod",
    "app.Dockerfile",
    "app.dockerfile",
    "docker/Dockerfile",
    "ci/Dockerfile.test",
  ]) {
    const n = nodeOf(
      { "package.json": "{}", [name]: "FROM node:22-alpine\n" },
      ".",
    )[0].node;
    assert.equal(n?.source, "dockerfile", name);
  }
  for (const name of [
    "Dockerfile.md",
    "dockerfile-notes.txt",
    "Dockerfilefoo",
    "dist/Dockerfile",
  ]) {
    const n = nodeOf(
      { "package.json": "{}", [name]: "FROM node:22-alpine\n" },
      ".",
    )[0].node;
    assert.equal(n?.source, "default", name);
  }
});

test("disagreeing Dockerfiles take the highest supported major", () => {
  const [c, pkg] = nodeOf(
    {
      "package.json": "{}",
      Dockerfile: "FROM node:22-alpine\n",
      "docker/Dockerfile": "FROM node:24\n",
      "ci/Dockerfile": "FROM node:18\n",
    },
    ".",
  );
  assert.deepEqual(
    [c.node?.version, c.node?.variant, c.node?.source],
    ["24", "debian", "dockerfile"],
  );
  assert.deepEqual(c.node?.not_checked_versions, [
    "18 (ci/Dockerfile)",
    "22 (Dockerfile)",
  ]);
  assert.equal(pkg.nodeChoice.unsupported, null);
});

test("other declared versions are recorded as not checked", () => {
  const [c] = nodeOf(
    {
      "package.json": '{"engines":{"node":">=24"}}',
      Dockerfile: "FROM node:22\n",
      ".nvmrc": "24\n",
      ".node-version": "v22.1.0\n",
    },
    ".",
  );
  assert.deepEqual([c.node?.version, c.node?.source], ["22", "dockerfile"]);
  assert.deepEqual(c.node?.not_checked_versions, [
    "24 (.nvmrc)",
    ">=24 (engines.node)",
  ]);
});

test("an engines range that the chosen version satisfies is not listed", () => {
  const [c] = nodeOf(
    { "package.json": '{"engines":{"node":">=22"}}', ".nvmrc": "22" },
    ".",
  );
  assert.deepEqual(c.node?.not_checked_versions, []);
});

test("a Dockerfile in a nested package belongs to that package", () => {
  const files = {
    "package.json": "{}",
    Dockerfile: "FROM node:22\n",
    "packages/a/package.json": "{}",
    "packages/a/Dockerfile": "FROM node:24-alpine\n",
    "packages/b/package.json": "{}",
  };
  const root = nodeOf(files, ".")[0].node;
  const a = nodeOf(files, "packages/a")[0].node;
  const b = nodeOf(files, "packages/b")[0].node;
  assert.equal(root?.version, "22");
  assert.deepEqual(root.not_checked_versions, []);
  assert.deepEqual([a?.version, a?.variant], ["24", "alpine"]);
  assert.deepEqual(
    [b?.version, b?.source],
    ["24", "default"],
    "the root Dockerfile does not reach into packages",
  );
});

test("an unsupported version is reported with the reason and runs nothing", async (t) => {
  const cases: Record<string, Record<string, string>> = {
    dockerfile: { "package.json": "{}", Dockerfile: "FROM node:18-alpine\n" },
    nvmrc: { "package.json": "{}", ".nvmrc": "20.1.0\n" },
    engines: { "package.json": '{"engines":{"node":"^18"}}' },
    "engines below": { "package.json": '{"engines":{"node":"<22"}}' },
    "engines exact": { "package.json": '{"engines":{"node":"20.11.0"}}' },
  };
  for (const [name, files] of Object.entries(cases)) {
    await t.test(name, () => {
      const [c, pkg] = nodeOf(files, ".");
      assert.equal(c.node, null, "no Node for an unsupported version");
      const u = pkg.nodeChoice.unsupported;
      assert.equal(u?.code, "node_version_unsupported");
      assert.ok(u.reason.includes("22, 24 and 26"));
      assert.equal(pkg.installUnsupported?.code, "node_version_unsupported");
    });
  }
});

test("an unsupported Dockerfile version loses to a supported one", () => {
  const [c, pkg] = nodeOf(
    {
      "package.json": "{}",
      Dockerfile: "FROM node:18\n",
      "Dockerfile.new": "FROM node:22-alpine\n",
    },
    ".",
  );
  assert.ok(c.node);
  assert.deepEqual([c.node.version, c.node.variant], ["22", "alpine"]);
  assert.equal(pkg.nodeChoice.unsupported, null);
  assert.deepEqual(c.node.not_checked_versions, ["18 (Dockerfile)"]);
});

test("the unsupported reason keeps an existing install reason", () => {
  const [, pkg] = nodeOf(
    { "package.json": "{}", "pnpm-lock.yaml": "", ".nvmrc": "18" },
    ".",
  );
  assert.ok(pkg.installUnsupported);
  assert.notEqual(pkg.installUnsupported.code, "node_version_unsupported");
  assert.ok(
    pkg.nodeChoice.unsupported,
    "the Node version is still unsupported",
  );
});

// Version strings come from the project and are untrusted. Whatever they
// say, the image is one of the pinned table entries.
test("hostile version strings never reach the image", () => {
  for (const h of [
    '22" --privileged',
    "22$(id)",
    "22 && rm -rf /",
    "../../etc",
    "22\n24",
  ]) {
    const n = nodeOf({ "package.json": "{}", ".nvmrc": h }, ".")[0].node;
    if (n) {
      assert.equal(n.image, "node@" + n.image_digest, h);
      assert.ok(!/[ $"&]/.test(n.image), h);
    }
  }
  const n = nodeOf(
    { "package.json": "{}", Dockerfile: "FROM node:22$(id)\n" },
    ".",
  )[0].node;
  assert.equal(n?.source, "default", "a tag with shell syntax must not count");
});

test("hostile declared versions stay out of the not-checked list", () => {
  const [c] = nodeOf(
    {
      "package.json": `{"engines":{"node":"${"9".repeat(300)}"}}`,
      ".nvmrc": "22",
    },
    ".",
  );
  for (const s of c.node?.not_checked_versions ?? []) {
    assert.ok(
      Buffer.byteLength(s) <= 120,
      `not-checked entry is ${String(s.length)} bytes long`,
    );
  }
});

test("a Dockerfile that is a symlink is never read", () => {
  // The Snapshot has no symlinks, but discovery also runs on the Original.
  const outside = tempDir();
  writeFileSync(join(outside, "target"), "FROM node:22\n");
  const root = tempDir();
  writeFileSync(join(root, "package.json"), "{}");
  symlinkSync(join(outside, "target"), join(root, "Dockerfile"));
  for (const c of discover(root).contexts) {
    if (c.package) assert.equal(c.node?.source, "default");
  }
});
