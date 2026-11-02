import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ServiceCPUs,
  serviceFamilyOf,
  ServiceMemoryMB,
} from "../toolset/services.ts";
import { imageRef } from "../toolset/toolset.ts";
import { never, realDriver, sleep } from "./realdocker.testutil.ts";

test("a Service is reachable under its alias on an internal network and gone afterwards", async (t) => {
  const { d } = await realDriver(t, "service-aaaa");
  const fam = serviceFamilyOf("valkey/valkey");
  assert.ok(fam, "no valkey family");
  const image = imageRef(fam.image);
  await d.pull(never, image);

  const net = await d.createNetwork(never, "svcnet", true);
  const svc = await d.startService(never, {
    name: "svc-redis",
    alias: "redis",
    image,
    network: net,
    cpus: ServiceCPUs,
    memoryMB: ServiceMemoryMB,
  });

  for (const until = Date.now() + 30_000; ;) {
    const res = await d.exec(never, svc, ...fam.probe);
    if (res.exitCode === 0) {
      break;
    }
    if (Date.now() > until) {
      assert.fail(
        `the probe never passed: ${res.stdout.toString()} ${res.stderr.toString()}\nlogs: ${await d.logs(never, svc)}`,
      );
    }
    await sleep(200);
  }

  // Another container of the network reaches it by its compose name.
  const res = await d.runContainer(never, {
    name: "client",
    image,
    cmd: ["valkey-cli", "-h", "redis", "ping"],
    network: net,
    cpus: 1,
    memoryMB: 256,
  });
  assert.equal(res.exitCode, 0, res.stderr.toString());
  assert.ok(res.stdout.toString().includes("PONG"), res.stdout.toString());

  assert.equal(
    await d.running(never, svc),
    true,
    "the Service is not reported as running",
  );

  await d.removeService(svc);
  assert.equal(
    await d.running(never, svc),
    false,
    "the Service is reported as running after removeService",
  );
  await d.removeNetwork(net);
  await assert.rejects(d.exec(never, svc, "true"), /no such container/);
});

test("a Service never takes a host path or a foreign container name", async (t) => {
  const { d } = await realDriver(t, "service-bbbb");
  await assert.rejects(
    d.exec(never, "some-other-container", "true"),
    /not a run-owned container/,
  );
  await assert.rejects(
    d.removeService("postgres"),
    /not a run-owned container/,
  );
  await assert.rejects(
    d.startService(never, {
      name: "x",
      alias: "--privileged",
      image: "x@sha256:0",
      network: "jspf-x",
    }),
    /refusing to start a Service under the name "--privileged"/,
  );
});
