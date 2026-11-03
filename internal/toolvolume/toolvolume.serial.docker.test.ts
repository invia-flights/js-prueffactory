// These tests fill real toolset volumes.
// Every test uses its own toolset version string, so it never touches the
// volume of a real Run, and removes what it created. The driver's docker CLI
// is a wrapper that lists only this file's volumes, so the removal of other
// toolset versions never reaches a volume of another test, agent or Run on
// the shared daemon.
//
// The file is serial (`*.serial.docker.test.ts`): `npm run test:docker` runs
// it after the parallel pass. Every Run that starts removes the unused
// toolset volumes of other versions on the daemon (host-wide, under a lock
// of its own cache folder, which these tests do not share), so a test volume
// that no container holds for a moment would vanish under a concurrent Run
// of internal/cli.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";

import { Driver, env, locate } from "../docker/driver.ts";
import {
  assertGone,
  docker,
  never,
  nodeRef,
  uniqueRunID,
} from "../docker/realdocker.testutil.ts";
import { Alpine, Helm, type HelmDownload } from "../toolset/helm.ts";
import { imageRef } from "../toolset/toolset.ts";
import { HelmBin, MountPath } from "./helm.ts";
import { ensure, volumeName } from "./toolvolume.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

const getenv = (k: string): string => process.env[k] ?? "";

// nonce is in every volume name this file creates; the wrapper CLI lists
// only those.
const nonce = "t13" + randomBytes(5).toString("hex");

const wrapperDir = realpathSync(
  mkdtempSync(join(tmpdir(), "jspf-toolvolume-cli-")),
);
const real = locate(getenv);
writeFileSync(
  join(wrapperDir, "docker"),
  `#!/bin/sh
case "$1 $2" in
  "volume ls") "${real}" "$@" | grep -F -- "${nonce}" ; exit 0 ;;
esac
exec "${real}" "$@"
`,
  { mode: 0o755 },
);
const base = new Driver(join(wrapperDir, "docker"), env(getenv));
const image = nodeRef();

async function setup(): Promise<void> {
  await base.preflight(never);
  await base.pull(never, image);
}
const ready = setup();

/** newScope is the Driver of one Run; its resources go when the test ends. */
function newScope(t: TestContext): Driver {
  const runID = uniqueRunID("t13");
  const d = base.withScope({
    runID,
    host: "test-host",
    pid: process.pid,
    deadline: new Date(Date.now() + 3_600_000),
  });
  t.after(async () => {
    await d.removeRunResources();
    assertGone(runID);
  });
  return d;
}

let versions = 0;
/**
 * uniqueVersion is a toolset version of this test. Its volume is removed
 * when the file ends, after the Runs that hold it (node:test runs a test's
 * after hooks first in, first out, unlike Go's t.Cleanup).
 */
function uniqueVersion(): string {
  return `${nonce}x${String(++versions)}`;
}

after(() => {
  const names = docker("volume", "ls", "-q", "--filter", "name=" + nonce);
  for (const name of names.stdout.split("\n")) {
    if (name.trim() !== "") {
      removeVolume(name.trim());
    }
  }
  rmSync(wrapperDir, { recursive: true, force: true });
});

// removeVolume is the test's own cleanup; it does not use the code under test.
function removeVolume(name: string): void {
  docker("volume", "rm", "-f", name);
}

function volumeCreatedAt(name: string): string {
  const r = docker("volume", "inspect", "--format", "{{.CreatedAt}}", name);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function volumeLabels(name: string): string {
  return docker("volume", "inspect", "--format", "{{json .Labels}}", name)
    .stdout;
}

function volumeExists(name: string): boolean {
  return docker("volume", "inspect", name).status === 0;
}

test("the tools are installed once and reused by the next Run", async (t) => {
  await ready;
  const cache = tempDir(t);
  const version = uniqueVersion();

  const first = newScope(t);
  let logs: string[] = [];
  const v1 = await ensure(never, {
    docker: first,
    cacheDir: cache,
    version,
    image,
    logf: (s) => logs.push(s),
  });
  assert.deepEqual(v1, { name: "jspf-toolset-" + version, installed: true });
  assert.ok(logs.join("\n").includes("installing"), logs.join("\n"));

  // The volume carries the cache labels, never a run label, so a Run's
  // cleanup keeps it.
  const labels = volumeLabels(v1.name);
  assert.ok(labels.includes(`"js-prueffactory.cache":"toolset"`), labels);
  assert.ok(labels.includes(version), labels);
  assert.ok(!labels.includes("run-id"), labels);

  // The installed tool is there and can run, on the same image.
  const cr = await first.runContainer(never, {
    name: "probe",
    image,
    network: "none",
    mounts: [{ volume: v1.name, path: "/toolset", readOnly: true }],
    cmd: ["node", "/toolset/node_modules/jscpd/run-jscpd.js", "--version"],
  });
  assert.equal(cr.exitCode, 0, cr.stderr.toString());
  assert.ok(cr.stdout.toString().includes("5.4.2"), cr.stdout.toString());

  // The Helm binary is installed and runs in the pinned Alpine image (Go:
  // TestTheHelmBinaryIsInstalledAndRunsInThePinnedAlpineImage, here on the
  // same volume to spare an install).
  await base.pull(never, imageRef(Alpine));
  const helm = await first.runContainer(never, {
    name: "helm-probe",
    image: imageRef(Alpine),
    network: "none",
    mounts: [{ volume: v1.name, path: MountPath, readOnly: true }],
    cmd: [HelmBin, "version", "--short"],
  });
  assert.equal(helm.exitCode, 0, helm.stderr.toString());
  assert.ok(
    helm.stdout.toString().startsWith("v" + Helm.version),
    helm.stdout.toString(),
  );

  // A later Run, with another run ID, reuses the volume without installing.
  const created = volumeCreatedAt(v1.name);
  logs = [];
  const v2 = await ensure(never, {
    docker: newScope(t),
    cacheDir: cache,
    version,
    image,
    logf: (s) => logs.push(s),
  });
  assert.deepEqual(v2, { name: v1.name, installed: false });
  assert.ok(!logs.join("\n").includes("installing"), logs.join("\n"));
  assert.ok(logs.join("\n").includes("reusing"), logs.join("\n"));
  assert.equal(volumeCreatedAt(v1.name), created, "the volume was recreated");
});

test("a volume of the right name without labels is replaced, not trusted", async (t) => {
  // Docker creates a missing named volume without labels when a container
  // mounts it. Such a volume would never be recognised by the cleanup of old
  // toolset versions, so ensure replaces it.
  await ready;
  const version = uniqueVersion();
  const name = volumeName(version);
  const r = docker("volume", "create", name);
  assert.equal(r.status, 0, r.stderr);

  const v = await ensure(never, {
    docker: newScope(t),
    cacheDir: tempDir(t),
    version,
    image,
  });

  assert.equal(v.installed, true, "the unlabelled volume was reused");
  assert.ok(
    volumeLabels(name).includes(`"js-prueffactory.cache":"toolset"`),
    volumeLabels(name),
  );
});

test("two Runs starting together fill the volume once", async (t) => {
  await ready;
  const cache = tempDir(t);
  const version = uniqueVersion();

  const results = await Promise.all(
    [newScope(t), newScope(t)].map((d) =>
      ensure(never, { docker: d, cacheDir: cache, version, image }),
    ),
  );

  assert.notEqual(
    results[0]?.installed,
    results[1]?.installed,
    "exactly one Run installs",
  );
});

test("other toolset versions are removed but volumes in use are left alone", async (t) => {
  await ready;
  const cache = tempDir(t);
  const version = uniqueVersion();

  const stale = "jspf-toolset-t13stale" + version;
  const inUse = "jspf-toolset-t13inuse" + version;
  for (const name of [stale, inUse]) {
    const r = docker(
      "volume",
      "create",
      "--label",
      "js-prueffactory.cache=toolset",
      "--label",
      "js-prueffactory.toolset-version=" + name.slice("jspf-toolset-".length),
      name,
    );
    assert.equal(r.status, 0, r.stderr);
  }
  // Another Run still holds one of them: a created container counts as a user.
  const holder = "jspf-t13holder-" + version;
  const h = docker(
    "create",
    "--name",
    holder,
    "--pull",
    "never",
    "--volume",
    inUse + ":/toolset",
    image,
    "true",
  );
  assert.equal(h.status, 0, h.stderr);
  t.after(() => {
    docker("rm", "-f", holder);
  });
  // A volume without the cache label is not ours and must stay.
  const foreign = "jspf-toolset-t13foreign" + version;
  assert.equal(docker("volume", "create", foreign).status, 0);

  await ensure(never, {
    docker: newScope(t),
    cacheDir: cache,
    version,
    image,
  });

  assert.equal(
    volumeExists(stale),
    false,
    "the volume of another toolset version was kept",
  );
  assert.equal(
    volumeExists(inUse),
    true,
    "a volume that a container still uses was removed",
  );
  assert.equal(
    volumeExists(foreign),
    true,
    "a volume without the cache label was removed",
  );
  assert.equal(
    volumeExists(volumeName(version)),
    true,
    "the current toolset volume is gone",
  );
});

test("the Run keeps its toolset volume in use until its cleanup", async (t) => {
  // Another Run with a newer binary removes unused toolset volumes of other
  // versions. The Run must not lose its volume between install and use.
  await ready;
  const cache = tempDir(t);
  const version = uniqueVersion();
  const other = uniqueVersion();
  const mine = newScope(t);

  const v = await ensure(never, {
    docker: mine,
    cacheDir: cache,
    version,
    image,
  });
  await ensure(never, {
    docker: newScope(t),
    cacheDir: cache,
    version: other,
    image,
  });
  assert.equal(
    volumeExists(v.name),
    true,
    "another Run removed the volume of a running Run",
  );

  // After the Run's own cleanup the volume may go, and no container is left.
  await mine.removeRunResources();
  const runID = mine
    .name("")
    .replace(/^jspf-/, "")
    .replace(/-$/, "");
  const left = docker(
    "ps",
    "-a",
    "--filter",
    "label=js-prueffactory.run-id=" + runID,
    "-q",
  );
  assert.equal(left.stdout.trim(), "", "containers left after cleanup");
  assert.equal(
    volumeExists(v.name),
    true,
    "the Run's cleanup must keep the cache volume",
  );
});

test("a Helm checksum mismatch stops the Preparation and leaves no volume", async (t) => {
  await ready;
  const version = uniqueVersion();
  const downloads = new Map<string, HelmDownload>();
  for (const [arch, dl] of Helm.downloads) {
    downloads.set(arch, { ...dl, sha256: "0".repeat(64) });
  }

  await assert.rejects(
    ensure(never, {
      docker: newScope(t),
      cacheDir: tempDir(t),
      version,
      image,
      helm: { ...Helm, downloads },
    }),
    (err: Error) => err.message.includes("checksum"),
  );
  assert.equal(
    volumeExists(volumeName(version)),
    false,
    "a volume with an unverified binary must not stay",
  );
});
