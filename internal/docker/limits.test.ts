import assert from "node:assert/strict";
import { test } from "node:test";

import { never, recordingDriver } from "./docker.testutil.ts";
import type { ContainerSpec } from "./driver.ts";

test("every container is limited to two CPUs and four gigabytes", async (t) => {
  const cases: {
    name: string;
    spec: Partial<ContainerSpec>;
    want: string[];
    not?: string;
  }[] = [
    {
      name: "unset limits get the defaults",
      spec: {},
      want: ["--cpus 2", "--memory 4096m"],
    },
    {
      name: "a Service may ask for less",
      spec: { cpus: 1, memoryMB: 1024 },
      want: ["--cpus 1", "--memory 1024m"],
    },
    {
      name: "nothing may ask for more",
      spec: { cpus: 8, memoryMB: 16384 },
      want: ["--cpus 2", "--memory 4096m"],
      not: "--cpus 8",
    },
    {
      name: "a fraction of a CPU is written as Go writes it",
      spec: { cpus: 0.5, memoryMB: 256 },
      want: ["--cpus 0.5", "--memory 256m"],
    },
  ];
  for (const tc of cases) {
    await t.test(tc.name, async () => {
      const { d, rec } = recordingDriver();
      await d.runContainer(never, {
        ...tc.spec,
        image: "node@sha256:x",
        cmd: ["true"],
        network: "none",
      });
      const create = rec.createCall();
      for (const w of tc.want) {
        assert.ok(create.includes(w), `create call ${create} lacks ${w}`);
      }
      if (tc.not !== undefined) {
        assert.ok(!create.includes(tc.not), `create call ${create}`);
      }
    });
  }
});
