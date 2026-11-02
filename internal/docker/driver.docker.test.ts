// These tests talk to a real Docker daemon; an unreachable daemon fails them.
import assert from "node:assert/strict";
import type { Writable } from "node:stream";
import { test } from "node:test";

import { TarWriter } from "../tarwriter/tarwriter.ts";
import {
  LabelCache,
  LabelDeadline,
  LabelHost,
  LabelPID,
  LabelRunID,
  NetworkNone,
} from "./driver.ts";
import { docker, never, realDriver, sleep } from "./realdocker.testutil.ts";

function tarOf(files: Record<string, string>): (w: Writable) => Promise<void> {
  return async (w) => {
    const tw = new TarWriter(w);
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.from(content);
      await tw.writeHeader({
        type: "file",
        name,
        mode: 0o644,
        size: data.length,
      });
      await tw.write(data);
    }
    await tw.close();
  };
}

test("a volume receives a tar stream and a container reads it without a host mount", async (t) => {
  const { d, image } = await realDriver(t, "driver-aaaa");

  const vol = await d.createVolume(never, "data");
  await d.putTar(
    never,
    vol,
    image,
    tarOf({ "sub/hello.txt": "hello from the host" }),
  );
  let res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["cat", "/data/sub/hello.txt", "/jspf/extra.txt"],
    mounts: [{ volume: vol, path: "/data", readOnly: true }],
    files: [
      {
        path: "/jspf/extra.txt",
        content: Buffer.from(" and a copied-in file"),
      },
    ],
    cpus: 1,
    memoryMB: 256,
    workDir: "/data",
  });
  assert.equal(res.exitCode, 0, res.stderr.toString());
  assert.equal(
    res.stdout.toString(),
    "hello from the host and a copied-in file",
  );

  // A read-only mount really is read-only.
  res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["sh", "-c", "echo x > /data/new.txt"],
    mounts: [{ volume: vol, path: "/data", readOnly: true }],
  });
  assert.notEqual(res.exitCode, 0, "wrote into a read-only mount");
});

test("a non-zero exit and the output are reported", async (t) => {
  const { d, image } = await realDriver(t, "driver-bbbb");
  const res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["sh", "-c", "echo out; echo err >&2; exit 7"],
  });
  assert.equal(res.exitCode, 7);
  assert.equal(res.stdout.toString(), "out\n");
  assert.equal(res.stderr.toString(), "err\n");
  assert.equal(res.oomKilled, false);
});

test("a container that announces its end and keeps running is stopped after the grace period", async (t) => {
  const { d, image } = await realDriver(t, "driver-g23a");
  const started = Date.now();

  const res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["sh", "-c", "echo before; echo @@END-g23a@@ >&2; sleep 120"],
    endMarker: { text: "@@END-g23a@@", graceMs: 2000 },
  });

  assert.ok(res.stoppedAfterGrace && res.exitCode !== 0, JSON.stringify(res));
  assert.ok(
    Date.now() - started < 60_000,
    "the container should have been stopped after the 2 second grace",
  );
  assert.equal(res.stdout.toString(), "before\n");
  assert.equal(
    res.stderr.toString(),
    "",
    "the marker is not part of the output",
  );
});

test("a container that exits within the grace period is left alone", async (t) => {
  const { d, image } = await realDriver(t, "driver-g23b");

  const res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["sh", "-c", "echo @@END-g23b@@; sleep 1; echo done"],
    endMarker: { text: "@@END-g23b@@", graceMs: 30_000 },
  });

  assert.equal(res.stoppedAfterGrace, false);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.toString(), "done\n");
});

test("internal network, containers and labels belong to the Run", async (t) => {
  const { d, image, runID } = await realDriver(t, "driver-cccc");

  const net = await d.createNetwork(never, "net", true);
  assert.equal(net, `jspf-${runID}-net`);
  assert.equal(
    docker(
      "network",
      "inspect",
      "--format",
      "{{.Internal}}",
      net,
    ).stdout.trim(),
    "true",
  );

  // While a container runs it joins the network and carries the labels.
  const done = d.runContainer(never, {
    name: "sleeper",
    image,
    cmd: ["sleep", "4"],
    network: net,
  });
  const name = `jspf-${runID}-sleeper`;
  let inspect = "";
  for (const until = Date.now() + 3000; Date.now() < until;) {
    inspect = docker(
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      name,
    ).stdout.trim();
    if (inspect !== "") {
      break;
    }
    await sleep(100);
  }
  const labels = JSON.parse(inspect) as Record<string, string>;
  assert.equal(labels[LabelRunID], runID);
  assert.equal(labels[LabelHost], "test-host");
  assert.equal(labels[LabelPID], String(process.pid));
  assert.match(
    labels[LabelDeadline] ?? "",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  );
  const nets = docker(
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    name,
  ).stdout;
  assert.ok(nets.includes(net), `container did not join ${net}: ${nets}`);
  await done;
});

test("cancelling a running container removes it", async (t) => {
  const { d, image, runID } = await realDriver(t, "driver-dddd");

  await assert.rejects(
    d.runContainer(AbortSignal.timeout(1500), {
      network: NetworkNone,
      image,
      cmd: ["sleep", "60"],
    }),
  );
  const left = docker(
    "ps",
    "-a",
    "-q",
    "--filter",
    "label=js-prueffactory.run-id=" + runID,
  );
  assert.equal(left.stdout.trim(), "");
});

test("a cache volume carries the cache label, is reused and survives the Run", async (t) => {
  const { d, image } = await realDriver(t, "driver-cv13");
  const kind =
    "test13-" + new Date().toISOString().slice(11, 23).replace(/[:.]/g, "");
  let name = "";
  t.after(() => {
    if (name !== "") {
      docker("volume", "rm", "--force", name);
    }
  });

  name = await d.cacheVolume(never, kind);
  assert.equal(await d.cacheVolume(never, kind), name);
  await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["sh", "-c", "echo kept > /cache/marker"],
    mounts: [{ volume: name, path: "/cache" }],
  });

  // The volume has the cache label and no run label, so no Run removes it.
  const labels = JSON.parse(
    docker("volume", "inspect", "--format", "{{json .Labels}}", name).stdout,
  ) as Record<string, string>;
  assert.equal(labels[LabelCache], kind);
  assert.ok(
    !(LabelRunID in labels),
    `a cache volume must carry no run label: ${JSON.stringify(labels)}`,
  );
  await d.removeRunResources();
  const res = await d.runContainer(never, {
    network: NetworkNone,
    image,
    cmd: ["cat", "/cache/marker"],
    mounts: [{ volume: name, path: "/cache", readOnly: true }],
  });
  assert.equal(
    res.stdout.toString().trim(),
    "kept",
    "the cache did not survive the Run",
  );
});
