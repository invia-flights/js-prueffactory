// The network isolation probe against a real daemon (Go:
// isolation_docker_test.go).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { Driver, env, locate } from "../docker/driver.ts";
import {
  assertGone,
  never,
  sleep,
  uniqueRunID,
} from "../docker/realdocker.testutil.ts";
import { Logger } from "../progress/progress.ts";
import {
  IsolationConfirmed,
  IsolationNotIsolated,
} from "../resultset/types.ts";
import { nodeImage, VariantAlpine } from "../toolset/node.ts";
import {
  ServiceCPUs,
  serviceFamilyOf,
  ServiceMemoryMB,
} from "../toolset/services.ts";
import { imageRef } from "../toolset/toolset.ts";
import type { RunState } from "./engine.ts";
import { Lines, runState } from "./engine.testutil.ts";
import { probeIsolation } from "./isolation.ts";

const getenv = (k: string): string => process.env[k] ?? "";

async function isolationRun(
  t: TestContext,
  tag: string,
  internal: boolean,
): Promise<[RunState, Lines]> {
  const runID = uniqueRunID(tag);
  const drv = new Driver(locate(getenv), env(getenv)).withScope({
    runID,
    host: "test-host",
    pid: process.pid,
    deadline: new Date(Date.now() + 3_600_000),
  });
  t.after(async () => {
    await drv.removeRunResources();
    assertGone(runID);
  });
  const stderr = new Lines();
  const r = runState(t, { docker: drv, log: new Logger(stderr) });
  r.network = await drv.createNetwork(never, "net", internal);
  return [r, stderr];
}

test("the probe confirms isolation on an internal network", async (t) => {
  const [r, stderr] = await isolationRun(t, "isolation-aaaa", true);

  await probeIsolation(r, never);

  assert.equal(r.isolation, IsolationConfirmed, stderr.text);
  assert.deepEqual(r.limitations, []);
  await assertFastLookupFailureAndServiceNamesResolve(t, r);
});

// lookupScript is what a project test does: Node's own dns.lookup. It prints
// how many seconds the lookup of a host that nothing provides took and
// whether the Run Service's name resolves.
const lookupScript = `const dns = require('dns');
const t0 = Date.now();
dns.lookup('unknown-host.invalid', (e) => {
  console.log('unknown_code=' + (e ? e.code : ''));
  console.log('unknown_seconds=' + (Date.now() - t0) / 1000);
  dns.lookup('redis', (e2) => console.log('service_code=' + (e2 ? e2.code : 'ok')));
});`;

// ADR-0004: a test that calls a host the Run does not provide must fail
// fast. A lookup of an unknown name on the internal network fails within 2
// seconds (the Docker default is 5), and a Run Service's name still resolves.
async function assertFastLookupFailureAndServiceNamesResolve(
  t: TestContext,
  r: RunState,
): Promise<void> {
  const drv = r.cfg.docker;
  assert.ok(drv);
  const fam = serviceFamilyOf("valkey/valkey");
  assert.ok(fam, "no valkey family");
  await drv.pull(never, imageRef(fam.image));
  const node = nodeImage(24, VariantAlpine);
  assert.ok(node, "no Node 24 alpine image");
  await drv.pull(never, imageRef(node));
  const svc = await drv.startService(never, {
    name: "lookup-redis",
    alias: "redis",
    image: imageRef(fam.image),
    network: r.network,
    cpus: ServiceCPUs,
    memoryMB: ServiceMemoryMB,
  });
  t.after(async () => {
    await drv.removeService(svc);
  });

  // A Service's alias is registered once its container runs; wait for that.
  let out: Map<string, string>;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const c = await drv.runContainer(never, {
      name: "lookup-client",
      image: imageRef(node),
      network: r.network,
      cmd: ["node", "-e", lookupScript],
      cpus: 1,
      memoryMB: 128,
    });
    out = new Map();
    for (const line of c.stdout.toString().split("\n")) {
      const i = line.indexOf("=");
      if (i >= 0) {
        out.set(line.slice(0, i), line.slice(i + 1));
      }
    }
    if (out.get("service_code") === "ok" || Date.now() > deadline) {
      break;
    }
    await sleep(200);
  }
  const got = JSON.stringify([...out]);
  assert.equal(
    out.get("service_code"),
    "ok",
    `the Run Service name does not resolve: ${got}`,
  );
  assert.ok(
    (out.get("unknown_code") ?? "") !== "",
    `a lookup of an unknown name did not fail: ${got}`,
  );
  const secs = Number.parseFloat(out.get("unknown_seconds") ?? "");
  assert.ok(Number.isFinite(secs), `no timing in ${got}`);
  assert.ok(
    secs < 2,
    `a lookup of an unknown name took ${String(secs)} s, want under 2 s (the Docker default is 5 s)`,
  );
}

// A network with a route out stands in for a Docker that ignores --internal.
test("the probe reports an open network as a Limitation and a warning and goes on", async (t) => {
  const [r, stderr] = await isolationRun(t, "isolation-bbbb", false);

  await probeIsolation(r, never);

  assert.equal(r.isolation, IsolationNotIsolated, stderr.text);
  assert.deepEqual(
    r.limitations.map((l) => l.reason_code),
    ["network_not_isolated"],
  );
  assert.ok(
    stderr.text.includes("warning: network isolation is NOT in effect"),
    stderr.text,
  );
});
