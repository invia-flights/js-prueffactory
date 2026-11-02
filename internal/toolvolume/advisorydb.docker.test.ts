// Go: advisorydb_docker_test.go. These tests fill a real advisory database
// volume from the network. Every test uses its own cache kind, so it never
// touches the volume of a real Run (jspf-cache-osv-db), and removes only its
// own volume. The last test reads the shared volume, which a Run of either
// build fills, and changes nothing in it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { type Driver, LabelCache, NetworkNone } from "../docker/driver.ts";
import { docker, never, realDriver } from "../docker/realdocker.testutil.ts";
import { Alpine } from "../toolset/helm.ts";
import { OSVScanner } from "../toolset/osvscanner.ts";
import { imageRef } from "../toolset/toolset.ts";
import {
  type AdvisoryConfig,
  AdvisoryCacheDir,
  AdvisoryMountPath,
  ensureAdvisoryDB,
} from "./advisorydb.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "jspf-advisory-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** testKind is a cache kind no real Run uses; its volume is removed after the test. */
function testKind(t: TestContext): string {
  const kind = "t19x" + randomBytes(6).toString("hex");
  t.after(() => {
    docker("volume", "rm", "--force", "jspf-cache-" + kind);
  });
  return kind;
}

const wrongScanner = "ghcr.io/google/osv-scanner@sha256:" + "0".repeat(64);

async function advisoryConfig(
  t: TestContext,
  kind: string,
  cacheDir: string,
  now: Date,
): Promise<AdvisoryConfig & { d: Driver }> {
  const { d } = await realDriver(t, "advisorydb");
  for (const img of [imageRef(OSVScanner.image), imageRef(Alpine)]) {
    await d.pull(never, img);
  }
  return {
    d,
    docker: d,
    cacheDir,
    kind,
    scanner: imageRef(OSVScanner.image),
    helper: imageRef(Alpine),
    now: () => now,
  };
}

test("the advisory database is downloaded once and refreshed after a day", async (t) => {
  // Go: TestTheAdvisoryDatabaseIsDownloadedOnceAndRefreshedAfterADay
  const kind = testKind(t);
  const cache = tempDir(t);
  const start = new Date("2026-10-26T09:00:00Z");
  const hours = (n: number): Date => new Date(start.getTime() + n * 3_600_000);

  const cfg = await advisoryConfig(t, kind, cache, start);
  const first = await ensureAdvisoryDB(never, cfg);
  assert.equal(first.refreshed, true);
  assert.equal(first.name, "jspf-cache-" + kind);
  assert.equal(first.date.getTime(), start.getTime());
  assert.equal(
    await cfg.d.volumeLabel(never, first.name, LabelCache),
    kind,
    "the volume must survive the Run",
  );
  // The database is where the scan will look for it.
  const probe = await cfg.d.runContainer(never, {
    name: "probe",
    image: imageRef(Alpine),
    network: NetworkNone,
    mounts: [{ volume: first.name, path: AdvisoryMountPath, readOnly: true }],
    cmd: [
      "sh",
      "-c",
      `find ${AdvisoryCacheDir} -name all.zip -size +1000k | grep -c .`,
    ],
  });
  assert.equal(probe.exitCode, 0, "no database file below " + AdvisoryCacheDir);

  // Within a day the next Run reuses it and records the same date.
  const second = await ensureAdvisoryDB(never, {
    ...cfg,
    now: () => hours(23),
  });
  assert.deepEqual(
    [second.refreshed, second.date.getTime(), second.warning],
    [false, start.getTime(), ""],
  );

  // A refresh that cannot download keeps the old database and says so.
  const third = await ensureAdvisoryDB(never, {
    ...cfg,
    scanner: wrongScanner,
    now: () => hours(25),
  });
  assert.equal(third.refreshed, false);
  assert.equal(third.date.getTime(), start.getTime());
  assert.notEqual(third.warning, "");

  // After a day it downloads again and the date moves.
  const later = hours(26);
  const fourth = await ensureAdvisoryDB(never, { ...cfg, now: () => later });
  assert.deepEqual(
    [fourth.refreshed, fourth.date.getTime(), fourth.warning],
    [true, later.getTime(), ""],
  );
});

test("without a database a failed download is an error", async (t) => {
  // Go: TestWithoutADatabaseAFailedDownloadIsAnError
  const kind = testKind(t);
  const cfg = await advisoryConfig(t, kind, tempDir(t), new Date());
  await assert.rejects(
    ensureAdvisoryDB(never, { ...cfg, scanner: wrongScanner }),
    /the advisory database could not be downloaded/,
  );
});

test("a database that the Go build fetched is reused within 24 hours", async (t) => {
  // The real volume is only read: the Go build and this one share its name,
  // label, layout and date file.
  const probe = docker(
    "volume",
    "inspect",
    "--format",
    `{{index .Labels "${LabelCache}"}}`,
    "jspf-cache-osv-db",
  );
  if (probe.status !== 0) {
    t.skip("no advisory database volume on this daemon yet");
    return;
  }
  assert.equal(probe.stdout.trim(), "osv-db");
  const cfg = await advisoryConfig(t, "osv-db", tempDir(t), new Date());
  const date = await readDate(cfg.d);
  if (date === null || Date.now() - date.getTime() > 24 * 3_600_000) {
    t.skip(
      "the shared advisory database is older than a day; reusing needs a fresh one",
    );
    return;
  }
  // The scanner is unusable, so a reuse is the only way this succeeds.
  const got = await ensureAdvisoryDB(never, { ...cfg, scanner: wrongScanner });
  assert.deepEqual(
    [got.name, got.refreshed, got.date.getTime()],
    ["jspf-cache-osv-db", false, date.getTime()],
  );
});

async function readDate(d: Driver): Promise<Date | null> {
  const res = await d.runContainer(never, {
    name: "date",
    image: imageRef(Alpine),
    network: NetworkNone,
    mounts: [
      { volume: "jspf-cache-osv-db", path: AdvisoryMountPath, readOnly: true },
    ],
    cmd: ["sh", "-c", `cat ${AdvisoryMountPath}/updated-at`],
  });
  if (res.exitCode !== 0) {
    return null;
  }
  const date = new Date(res.stdout.toString().trim());
  return Number.isNaN(date.getTime()) ? null : date;
}
