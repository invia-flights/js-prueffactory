import assert from "node:assert/strict";
import { test } from "node:test";

import { NetworkNone } from "./driver.ts";
import { docker, never, realDriver, sleep } from "./realdocker.testutil.ts";

test("a running container has two CPUs and four gigabytes", async (t) => {
  const { d, image, runID } = await realDriver(t, "driver-limits");

  // The spec asks for no limits at all.
  const done = d.runContainer(never, {
    network: NetworkNone,
    name: "limited",
    image,
    cmd: ["sleep", "4"],
  });
  const name = `jspf-${runID}-limited`;
  let out = "";
  for (const until = Date.now() + 5000; Date.now() < until;) {
    out = docker(
      "inspect",
      "--format",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
      name,
    ).stdout.trim();
    if (out !== "") {
      break;
    }
    await sleep(100);
  }
  assert.equal(out, "2000000000 4294967296");
  await done;
});
