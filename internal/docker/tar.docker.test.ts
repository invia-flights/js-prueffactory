// The tar bytes the TypeScript build streams into a volume may differ from
// Go's; the files they unpack to may not (spec: paths, contents, modes,
// symbolic links). testdata/go-volume-files.json holds what the Go driver
// unpacked from Go's Snapshot.WriteTar for each tree, listed by the same
// script in the pinned Node image.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NetworkNone } from "./driver.ts";
import { never, realDriver } from "./realdocker.testutil.ts";
import { buildSyntheticTree, writeTreeTar } from "./tree.testutil.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("testdata/go-volume-files.json", import.meta.url),
    "utf8",
  ),
) as { script: string; listings: Record<string, string> };

const projects = new URL("../../testdata/projects/", import.meta.url);

function treeOf(name: string): string {
  if (name === "synthetic") {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jspf-synthetic-")));
    buildSyntheticTree(dir);
    return dir;
  }
  return new URL(name + "/", projects).pathname;
}

for (const name of ["symlinks", "sub-package", "synthetic"]) {
  test(`the files unpacked in a volume equal the Go build's: ${name}`, async (t) => {
    const want = fixture.listings[name];
    assert.ok(want !== undefined, name);
    const { d, image } = await realDriver(t, "tar-" + name.slice(0, 4));

    const vol = await d.createVolume(never, "snap");
    await d.putTar(never, vol, image, (w) => writeTreeTar(treeOf(name), w));
    const res = await d.runContainer(never, {
      network: NetworkNone,
      image,
      cmd: ["sh", "-c", fixture.script],
      mounts: [{ volume: vol, path: "/data", readOnly: true }],
    });

    assert.equal(res.stderr.toString(), "");
    assert.equal(res.stdout.toString(), want);
  });
}
