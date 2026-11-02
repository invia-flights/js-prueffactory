// ADR-0001: the driver offers no way to mount a host folder. Every function
// that creates a container or a volume is called here, with harmless and with
// hostile input, and every argument list that reaches the docker CLI is
// checked.
import assert from "node:assert/strict";
import { test } from "node:test";

import { never, recordingDriver } from "./docker.testutil.ts";

const hostPaths = [
  "/Users/me/project",
  "/",
  "./relative",
  "../up",
  "~/home",
  "C:\\work",
  "jspf-x:/etc",
  "name with space",
  "--privileged",
];

// assertNoBindMount fails when an argument list could mount a host folder:
// a -v or --mount flag, or a --volume whose source is not a run-owned volume.
function assertNoBindMount(calls: string[][]): void {
  for (const args of calls) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      assert.ok(
        a !== "-v" && !a.startsWith("--mount") && !a.startsWith("-v="),
        `docker ${args.join(" ")} uses ${a}`,
      );
      if (a === "--volume" || a.startsWith("--volume=")) {
        const value = a === "--volume" ? (args[i + 1] ?? "") : a.slice(9);
        const source = value.split(":")[0] ?? "";
        assert.match(
          source,
          /^jspf-[A-Za-z0-9][A-Za-z0-9_.-]*$/,
          `docker ${args.join(" ")} mounts ${source}`,
        );
      }
    }
  }
}

test("no docker run argument list ever contains a bind mount of a host folder", async () => {
  const { d, rec } = recordingDriver();

  // Everything the driver can create, used as the Run uses it.
  const vol = await d.createVolume(never, "snap");
  const cache = await d.cacheVolume(never, "npm");
  await d.createCacheVolume(never, "jspf-toolset-abc", {
    "js-prueffactory.cache": "toolset",
  });
  const net = await d.createNetwork(never, "exec", true);
  await d.putTar(never, vol, "node@sha256:x", () => Promise.resolve());
  await d.hold(never, "toolset-hold", "node@sha256:x", cache, "/cache");
  await d.runContainer(never, {
    image: "node@sha256:x",
    cmd: ["true"],
    network: net,
    workDir: "/work",
    mounts: [
      { volume: vol, path: "/work" },
      { volume: cache, path: "/cache", readOnly: true },
    ],
    files: [{ path: "/jspf/helper.js", content: Buffer.from("1") }],
  });
  await d.runContainer(never, {
    image: "node@sha256:x",
    cmd: ["true"],
    preparation: true,
    mounts: [{ volume: vol, path: "/work" }],
  });
  await d.startService(never, {
    name: "svc",
    alias: "redis",
    image: "valkey@sha256:x",
    network: net,
  });
  const before = rec.calls().length;
  assert.ok(before >= 10);

  // Every hostile name is refused before the CLI is called.
  for (const p of hostPaths) {
    await assert.rejects(
      d.runContainer(never, {
        image: "node@sha256:x",
        network: "none",
        mounts: [{ volume: p, path: "/work" }],
      }),
    );
    await assert.rejects(
      d.putTar(never, p, "node@sha256:x", () => Promise.resolve()),
    );
    await assert.rejects(d.hold(never, "h", "node@sha256:x", p, "/x"));
    await assert.rejects(d.createCacheVolume(never, p, {}));
    await assert.rejects(
      d.startService(never, {
        name: "s",
        alias: "a",
        image: "x@sha256:0",
        network: p,
      }),
    );
  }
  for (const kind of ["../x", "/abs", "UPPER", "-flag", "a b"]) {
    await assert.rejects(d.cacheVolume(never, kind), /not a valid cache kind/);
  }
  assert.equal(rec.calls().length, before, "a hostile name reached the CLI");

  assertNoBindMount(rec.calls());
  const creates = rec.calls().filter((c) => c[0] === "create");
  assert.ok(creates.length >= 5);
  for (const c of creates) {
    assert.ok(c.includes("--label"), `docker ${c.join(" ")} is not labelled`);
  }
});
