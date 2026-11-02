import assert from "node:assert/strict";
import { test } from "node:test";

import { never, recordingDriver } from "./docker.testutil.ts";
import { type ContainerSpec, NetworkNone } from "./driver.ts";

const base = { image: "node@sha256:x", cmd: ["true"] };

// ADR-0004: only the Preparation phase has outbound access. A container that
// names neither a network nor the Preparation phase would silently get the
// default bridge, so it is refused.
test("a container must choose its network explicitly", async () => {
  const { d, rec } = recordingDriver();
  await assert.rejects(d.runContainer(never, base), /network/);
  assert.deepEqual(rec.calls(), [], "docker was called anyway");
});

test("only a Preparation container gets the default bridge", async (t) => {
  const cases: Record<
    string,
    {
      spec: Partial<ContainerSpec>;
      wantErr?: RegExp;
      wantNet?: string;
      wantNoFlag?: boolean;
    }
  > = {
    preparation: { spec: { preparation: true }, wantNoFlag: true },
    "no network": { spec: { network: NetworkNone }, wantNet: "none" },
    "a run-owned network": {
      spec: { network: "jspf-run-exec" },
      wantNet: "jspf-run-exec",
    },
    "preparation and a network": {
      spec: { preparation: true, network: "jspf-run-exec" },
      wantErr: /network/,
    },
    "the host network": { spec: { network: "host" }, wantErr: /network/ },
    "another container's network": {
      spec: { network: "container:abc" },
      wantErr: /network/,
    },
  };
  for (const [name, tc] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { d, rec } = recordingDriver();
      const run = d.runContainer(never, { ...base, ...tc.spec });
      if (tc.wantErr !== undefined) {
        await assert.rejects(run, tc.wantErr);
        return;
      }
      await run;
      const create = rec.createCall();
      if (tc.wantNoFlag === true) {
        assert.ok(!create.includes("--network"), create);
      }
      if (tc.wantNet !== undefined) {
        assert.ok(create.includes(`--network ${tc.wantNet} `), create);
      }
    });
  }
});

test("the refusal of a foreign network quotes it as Go does", async () => {
  const { d } = recordingDriver();
  await assert.rejects(d.runContainer(never, { ...base, network: "host" }), {
    message:
      'refusing to join the network "host": a container may only join a run-owned network or none',
  });
});

// ADR-0004: on the internal network a lookup of a host that is not a Run
// Service takes 5 s by default, so a project test that calls out hits the
// Mocha timeout instead of failing fast. Every container on a run-owned
// network therefore starts with a one-second, one-attempt resolver.
test("every container on the Run network gets fast-failing resolver options", async (t) => {
  const dnsOpts = ["--dns-opt timeout:1", "--dns-opt attempts:1"];
  const cases: Record<string, { spec: Partial<ContainerSpec>; want: boolean }> =
    {
      "a container on the run network": {
        spec: { network: "jspf-run-exec" },
        want: true,
      },
      "a container with no network": {
        spec: { network: NetworkNone },
        want: false,
      },
      "a preparation container": { spec: { preparation: true }, want: false },
    };
  for (const [name, tc] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { d, rec } = recordingDriver();
      await d.runContainer(never, { ...base, ...tc.spec });
      const create = rec.createCall();
      for (const opt of dnsOpts) {
        assert.equal(create.includes(opt), tc.want, `${create}: ${opt}`);
      }
    });
  }
});

test("every Service on the Run network gets fast-failing resolver options", async () => {
  const { d, rec } = recordingDriver();
  await d.startService(never, {
    name: "pg",
    alias: "postgres",
    image: "postgres@sha256:x",
    network: "jspf-run-exec",
  });
  const create = rec.createCall();
  for (const opt of ["--dns-opt timeout:1", "--dns-opt attempts:1"]) {
    assert.ok(create.includes(opt), `${create} lacks ${opt}`);
  }
});

test("every container is hardened", async () => {
  const { d, rec } = recordingDriver();
  await d.runContainer(never, { ...base, network: NetworkNone });
  const create = rec.createCall();
  for (const want of [
    "--security-opt no-new-privileges",
    "--pids-limit 4096",
    "--cap-drop ALL",
    "--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID --cap-add KILL --cap-add SETGID --cap-add SETUID",
  ]) {
    assert.ok(create.includes(want), `${create} lacks ${want}`);
  }
});

test("an environment variable name that could be an option is refused", async () => {
  const { d, rec } = recordingDriver();
  await assert.rejects(
    d.runContainer(never, {
      ...base,
      network: NetworkNone,
      env: { "A=B --privileged": "x" },
    }),
    {
      message:
        'refusing to pass the environment variable "A=B --privileged" to a container',
    },
  );
  assert.deepEqual(rec.calls(), [], "docker was called anyway");
});
