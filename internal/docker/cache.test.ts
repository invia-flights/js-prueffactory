import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { never, recordingCLI } from "./docker.testutil.ts";
import { Driver, LabelCache, LabelToolsetVersion } from "./driver.ts";

const fixture = JSON.parse(
  readFileSync(new URL("testdata/go-cache-args.json", import.meta.url), "utf8"),
) as { calls: { call: string; args: string[] }[] };

// A Run of either build finds the cache volumes of the other only if both
// name and label them alike: the argument lists are the Go build's, recorded
// in testdata/go-cache-args.json.
test("cache volumes get the Go build's names, labels and arguments", async () => {
  const rec = recordingCLI(
    `[ "$1 $2" = "volume rm" ] && { echo 'Error response from daemon: remove x: volume is in use' >&2; exit 1; }\n`,
  );
  const d = new Driver(rec.exe, undefined).withScope({
    runID: "RUN",
    host: "h",
    pid: 1,
    deadline: new Date(0),
  });

  assert.equal(await d.cacheVolume(never, "kind"), "jspf-cache-kind");
  await d.createCacheVolume(never, "jspf-toolset-VERSION", {
    [LabelToolsetVersion]: "VERSION",
    [LabelCache]: "toolset",
  });
  await d.listVolumes(never, `label=${LabelCache}=toolset`);
  await d.volumeLabel(never, "jspf-toolset-VERSION", LabelCache);
  assert.equal(
    await d.removeVolumeIfUnused(never, "jspf-toolset-VERSION"),
    false,
  );
  await d.hold(
    never,
    "toolset-hold",
    "node@sha256:x",
    "jspf-toolset-VERSION",
    "/toolset",
  );

  assert.deepEqual(
    rec.calls(),
    fixture.calls.map((c) => c.args),
  );
});

test("removing a cache volume tells in use, already gone and failed apart", async () => {
  const rec = recordingCLI(`case "$3" in
  jspf-busy) echo 'Error response from daemon: remove jspf-busy: volume is in use - [abc]' >&2; exit 1 ;;
  jspf-gone) echo 'Error response from daemon: get jspf-gone: No such volume' >&2; exit 1 ;;
  jspf-bad) printf 'x\\nError response from daemon: disk on fire\\n' >&2; exit 2 ;;
esac
`);
  const d = new Driver(rec.exe, undefined);
  assert.equal(await d.removeVolumeIfUnused(never, "jspf-free"), true);
  assert.equal(await d.removeVolumeIfUnused(never, "jspf-busy"), false);
  assert.equal(await d.removeVolumeIfUnused(never, "jspf-gone"), true);
  await assert.rejects(d.removeVolumeIfUnused(never, "jspf-bad"), {
    message:
      "docker volume rm jspf-bad failed (exit 2): Error response from daemon: disk on fire",
  });
});

test("a volume label is read trimmed, and volumes are listed by name", async () => {
  const rec = recordingCLI(`case "$1 $2" in
  "volume inspect") echo '  toolset  ' ;;
  "volume ls") printf 'jspf-toolset-a\\njspf-toolset-b\\n\\n' ;;
esac
`);
  const d = new Driver(rec.exe, undefined);
  assert.equal(
    await d.volumeLabel(never, "jspf-toolset-a", LabelCache),
    "toolset",
  );
  assert.deepEqual(await d.listVolumes(never, "label=x"), [
    "jspf-toolset-a",
    "jspf-toolset-b",
  ]);
});
