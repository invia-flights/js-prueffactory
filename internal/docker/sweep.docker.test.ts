import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { Driver, env, locate, rfc3339 } from "./driver.ts";
import { docker, never, realDriver } from "./realdocker.testutil.ts";

type Kind = "volume" | "network" | "container";

// plant creates a resource of kind with the js-prueffactory labels of a
// pretend Run. It is removed again when the test ends, whatever the sweep did.
function plant(
  t: TestContext,
  kind: Kind,
  image: string,
  runID: string,
  host: string,
  pid: number,
  deadline: Date,
): string {
  const name = `jspf-${runID}-planted`;
  const labels = [
    "--label",
    "js-prueffactory.run-id=" + runID,
    "--label",
    "js-prueffactory.host=" + host,
    "--label",
    `js-prueffactory.pid=${String(pid)}`,
    "--label",
    "js-prueffactory.deadline=" + rfc3339(deadline),
  ];
  const args =
    kind === "container"
      ? ["create", "--name", name, ...labels, image, "true"]
      : [kind, "create", ...labels, name];
  const r = docker(...args);
  assert.equal(r.status, 0, `docker ${args.join(" ")}: ${r.stderr}`);
  t.after(() => {
    if (kind === "container") {
      docker("rm", "-f", "-v", name);
    } else {
      docker(kind, "rm", name);
    }
  });
  return name;
}

function exists(kind: Kind, name: string): boolean {
  const args =
    kind === "container"
      ? ["inspect", "--type", "container", name]
      : [kind, "inspect", name];
  return docker(...args).status === 0;
}

function deadPID(): number {
  const r = spawnSync("true");
  assert.ok(r.pid > 0);
  return r.pid;
}

test("the sweep removes leftovers of dead Runs and spares live ones", async (t) => {
  // Other agents and CI jobs may run Docker tests on this daemon at the same
  // time, so every run ID here is unique.
  const nonce = (Date.now() % 1e9).toString(36) + process.pid.toString(36);
  const { d, image } = await realDriver(t, "sweepme");
  const host = hostname();
  const now = new Date();
  const dead = deadPID();
  const me = process.pid;
  const hour = 3_600_000;

  const all: { kind: Kind; name: string; wantGone: boolean; why: string }[] =
    [];
  const add = (
    kind: Kind,
    id: string,
    h: string,
    pid: number,
    deadline: Date,
    wantGone: boolean,
    why: string,
  ): void => {
    all.push({
      kind,
      name: plant(t, kind, image, id, h, pid, deadline),
      wantGone,
      why,
    });
  };
  for (const kind of ["volume", "network", "container"] as const) {
    const k = kind.slice(0, 1);
    add(
      kind,
      `20250101T000000Z-expired-${nonce}${k}`,
      "some-other-host",
      me,
      new Date(now.getTime() - 60_000),
      true,
      "past its deadline, even though its process runs",
    );
    add(
      kind,
      `20250101T000000Z-deadpid-${nonce}${k}`,
      host,
      dead,
      new Date(now.getTime() + hour),
      true,
      "from this host, process gone",
    );
    add(
      kind,
      `20250101T000000Z-alive-${nonce}${k}`,
      host,
      me,
      new Date(now.getTime() + hour),
      false,
      "live deadline and a running process",
    );
    add(
      kind,
      `20250101T000000Z-elsewhere-${nonce}${k}`,
      "some-other-host",
      dead,
      new Date(now.getTime() + hour),
      false,
      "another host, so its process cannot be judged",
    );
  }
  // A cache volume has a cache label and no run label: never touched.
  const cache = `jspf-cache-sweeptest-${String(now.getTime())}${nonce}`;
  assert.equal(
    docker("volume", "create", "--label", "js-prueffactory.cache=npm", cache)
      .status,
    0,
  );
  t.after(() => {
    docker("volume", "rm", cache);
  });
  // That the sweep spares the resources of its own Run is covered with a fake
  // CLI (sweep.test.ts): on a shared daemon any concurrent Run's sweep may
  // legitimately remove an abandoned-looking one.

  // Other tests and Runs share the daemon, and a real sweep would also remove
  // their abandoned leftovers. The sweep here sees the daemon through a docker
  // CLI that lists only what this test planted; everything else it does goes
  // to the real CLI unchanged.
  const getenv = (k: string): string => process.env[k] ?? "";
  const real = locate(getenv);
  const dir = mkdtempSync(join(tmpdir(), "jspf-sweep-cli-"));
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
case "$1 $2" in
  "ps --all"|"network ls"|"volume ls") "${real}" "$@" | grep -F -- "-${nonce}" ; exit 0 ;;
esac
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  const sweeper = new Driver(join(dir, "docker"), env(getenv)).withScope(
    d.scope,
  );

  const { error } = await sweeper.sweepLeftovers(never, now, host);
  assert.equal(error, undefined);

  for (const p of all) {
    assert.equal(
      !exists(p.kind, p.name),
      p.wantGone,
      `${p.kind} ${p.name}: ${p.why}`,
    );
  }
  assert.ok(exists("volume", cache), "the cache volume was removed");
});
