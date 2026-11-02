import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { envOf, fakeCLI, never, recordingDriver } from "./docker.testutil.ts";
import { apiAtLeast, Driver, env, locate, rfc3339 } from "./driver.ts";

test("locate finds the docker CLI on PATH", () => {
  const dir = fakeCLI("exit 0\n");
  assert.equal(
    locate(envOf({ PATH: "/nonexistent:" + dir })),
    join(dir, "docker"),
  );
});

test("locate reports a missing CLI", () => {
  const empty = mkdtempSync(join(tmpdir(), "jspf-empty-"));
  assert.throws(() => locate(envOf({ PATH: empty })), /docker CLI/);
});

test("preflight reports an unreachable daemon", async () => {
  const dir = fakeCLI(
    "echo 'Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?' >&2\nexit 1\n",
  );
  await assert.rejects(
    new Driver(join(dir, "docker"), undefined).preflight(never),
    {
      message:
        "the Docker daemon is not reachable: Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?",
    },
  );
});

test("preflight reads the daemon facts", async () => {
  const dir = fakeCLI(`case "$1" in
  info) echo '{"ServerVersion":"29.4.0","NCPU":8,"MemTotal":17179869184,"OSType":"linux","Architecture":"aarch64"}' ;;
  version) echo '{"Version":"29.4.0","ApiVersion":"1.56","MinAPIVersion":"1.44"}' ;;
esac
`);
  const info = await new Driver(join(dir, "docker"), undefined).preflight(
    never,
  );
  assert.deepEqual(info, {
    serverVersion: "29.4.0",
    apiVersion: "1.56",
    cpus: 8,
    memoryBytes: 17179869184,
    os: "linux",
    arch: "aarch64",
  });
});

test("API versions compare by major and minor; an unreadable one is too old", () => {
  assert.equal(apiAtLeast("1.41", "1.41"), true);
  assert.equal(apiAtLeast("1.56", "1.41"), true);
  assert.equal(apiAtLeast("2.0", "1.41"), true);
  assert.equal(apiAtLeast("1.41.9", "1.41"), true);
  assert.equal(apiAtLeast("1.40", "1.41"), false);
  assert.equal(apiAtLeast("", "1.41"), false);
  assert.equal(apiAtLeast("v1.50", "1.41"), false);
});

test("containers can only mount run-owned volumes, never host paths", async () => {
  const { d, rec } = recordingDriver("echo should-not-be-called >&2\nexit 9\n");
  for (const bad of [
    "/Users/me/project",
    "./relative",
    "../up",
    "~/home",
    "name with space",
  ]) {
    await assert.rejects(
      d.runContainer(never, {
        image: "node@sha256:x",
        cmd: ["true"],
        mounts: [{ volume: bad, path: "/work" }],
      }),
      /volume/,
      bad,
    );
  }
  assert.deepEqual(rec.calls(), []);
});

test("resource names carry the run prefix", () => {
  const d = new Driver("docker", undefined).withScope({
    runID: "20261025T101500Z-x-aaaa",
    host: "",
    pid: 0,
    deadline: new Date(0),
  });
  assert.equal(d.name("net"), "jspf-20261025T101500Z-x-aaaa-net");
});

test("the CLI gets only the Docker-related variables of the environment", () => {
  assert.deepEqual(
    env(
      envOf({
        PATH: "/bin",
        DOCKER_HOST: "tcp://d:2375",
        AWS_SECRET_ACCESS_KEY: "nope",
        HOME: "/home/u",
      }),
    ),
    ["PATH=/bin", "HOME=/home/u", "DOCKER_HOST=tcp://d:2375"],
  );
  assert.equal(env(envOf({})), undefined);
});

test("labels carry the deadline as RFC 3339 in UTC without fractions", () => {
  assert.equal(
    rfc3339(new Date("2026-10-25T10:15:00.123+02:00")),
    "2026-10-25T08:15:00Z",
  );
});

test("a failing call names the subcommand, the exit code and the last stderr line", async () => {
  const { d } = recordingDriver(
    `[ "$1" = volume ] && { printf 'warning\\nError response from daemon: boom\\n' >&2; exit 4; }\n`,
  );
  await assert.rejects(d.createVolume(never, "data"), {
    message:
      "docker volume create failed (exit 4): Error response from daemon: boom",
  });
});

test("a call on an ended signal fails as a cancelled Go context", async () => {
  const { d, rec } = recordingDriver();
  await assert.rejects(d.createVolume(AbortSignal.abort(), "data"), {
    message: "docker volume: context canceled",
  });
  const timedOut = AbortSignal.timeout(0);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(d.createVolume(timedOut, "data"), {
    message: "docker volume: context deadline exceeded",
  });
  assert.deepEqual(rec.calls(), []);
});

test("a cancelled container run removes its container", async () => {
  const { d, rec } = recordingDriver(`[ "$1" = start ] && exec sleep 30\n`);
  const ac = new AbortController();
  // Cancel once the container runs.
  const poll = setInterval(() => {
    if (rec.lines().some((l) => l.startsWith("start "))) {
      clearInterval(poll);
      setTimeout(() => {
        ac.abort();
      }, 100);
    }
  }, 20);
  const started = Date.now();
  await assert.rejects(
    d.runContainer(ac.signal, {
      image: "node@sha256:x",
      cmd: ["true"],
      network: "none",
    }),
    /context canceled/,
  );
  assert.ok(Date.now() - started < 10_000);
  const last = rec.lines().at(-1) ?? "";
  assert.match(
    last,
    /^rm --force --volumes jspf-20261025T101500Z-x-aaaa-c\d+$/,
  );
});
