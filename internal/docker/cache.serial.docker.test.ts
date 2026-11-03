import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LabelCache, NetworkNone } from "./driver.ts";
import { docker, never, realDriver } from "./realdocker.testutil.ts";

const fixture = JSON.parse(
  readFileSync(new URL("testdata/go-cache-args.json", import.meta.url), "utf8"),
) as { calls: { call: string; args: string[] }[] };

function goArgs(call: string, replace: [string, string][]): string[] {
  const c = fixture.calls.find((x) => x.call === call);
  assert.ok(c, call);
  return c.args.map((a) =>
    replace.reduce((s, [from, to]) => s.split(from).join(to), a),
  );
}

// User story 26: the first TypeScript Run reuses what the Go build downloaded.
// The volumes are created with the Go build's own argument lists (recorded in
// testdata/go-cache-args.json) under names no real cache uses.
test("a cache volume the Go build created is found and reused, not replaced", async (t) => {
  const { d, image } = await realDriver(t, "cache-go");
  const kind = "test11-" + randomBytes(4).toString("hex");
  const name = "jspf-cache-" + kind;
  const version = "test11" + randomBytes(4).toString("hex");
  const toolsetName = "jspf-toolset-" + version;
  t.after(() => {
    docker("volume", "rm", "--force", name);
    docker("volume", "rm", "--force", toolsetName);
  });

  // What the Go build leaves behind: the volumes with its labels and a file.
  for (const args of [
    goArgs("cacheVolume kind", [["kind", kind]]),
    goArgs("createCacheVolume toolset VERSION", [["VERSION", version]]),
  ]) {
    const r = docker(...args);
    assert.equal(r.status, 0, r.stderr);
  }
  // A Run that starts while this test runs removes the toolset volumes of
  // other versions, unless they are in use (the Go build does the same at
  // the start of a Run). The file is serial, so no Run of internal/cli
  // overlaps; the hold keeps the volume in use for the assertions below.
  await d.hold(never, "toolset-hold", image, toolsetName, "/toolset");
  for (const v of [name, toolsetName]) {
    const r = docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${v}:/cache`,
      image,
      "sh",
      "-c",
      "echo from-go > /cache/marker",
    );
    assert.equal(r.status, 0, r.stderr);
  }
  const created = docker(
    "volume",
    "inspect",
    "--format",
    "{{.CreatedAt}}",
    name,
  ).stdout;

  // The TypeScript driver finds the npm-style cache by kind ...
  assert.equal(await d.cacheVolume(never, kind), name);
  assert.equal(
    docker("volume", "inspect", "--format", "{{.CreatedAt}}", name).stdout,
    created,
    "the volume was replaced",
  );
  // ... and the toolset volume by its cache label and version.
  assert.ok(
    (await d.listVolumes(never, `label=${LabelCache}=toolset`)).includes(
      toolsetName,
    ),
  );
  assert.equal(await d.volumeLabel(never, toolsetName, LabelCache), "toolset");
  assert.equal(
    await d.volumeLabel(never, toolsetName, "js-prueffactory.toolset-version"),
    version,
  );

  for (const v of [name, toolsetName]) {
    const res = await d.runContainer(never, {
      network: NetworkNone,
      image,
      cmd: ["cat", "/cache/marker"],
      mounts: [{ volume: v, path: "/cache", readOnly: true }],
    });
    assert.equal(res.stdout.toString(), "from-go\n", v);
  }

  // The volume was held since its creation, so it is in use: another Run
  // cannot remove it; after the Run's cleanup it can.
  assert.equal(await d.removeVolumeIfUnused(never, toolsetName), false);
  await d.removeRunResources();
  assert.equal(await d.removeVolumeIfUnused(never, toolsetName), true);
  // Go treats only "No such volume" as already gone; Docker 29 says "no such
  // volume", so a second removal fails in both builds (noted for a later spec,
  // the Go code is frozen).
});
