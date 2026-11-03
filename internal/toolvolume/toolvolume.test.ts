import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { Driver } from "../docker/driver.ts";
import { Helm } from "../toolset/helm.ts";
import { version } from "../toolset/all.ts";
import { helmInstallScript } from "./helm.ts";
import { acquire } from "./lock.ts";
import { cleanOtherVersions, ensure, volumeName } from "./toolvolume.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

interface OracleCase {
  name: string;
  error: string;
  logs: string[];
  calls: string[][] | null;
}

const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as { cases: OracleCase[]; helmScript: string; volumeName: string };

const never = new AbortController().signal;

// The fake docker CLI of the Go recording (testdata/go-oracle.go.txt), word
// for word: it records every call and answers just enough.
const oracleScript = `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "$(dirname "$0")/calls"
printf '\\036' >> "$(dirname "$0")/calls"
case "$1 $2" in
  "volume inspect") case "$*" in *unlabelled*) echo "" ;; *) echo toolset ;; esac; exit 0 ;;
  "volume ls") for v in $VOLUMES; do echo "$v"; done; exit 0 ;;
  "volume rm") case "$3" in *busy*) echo 'Error response from daemon: remove x: volume is in use' >&2; exit 1 ;; esac; exit 0 ;;
esac
case "$1" in
  inspect)
    case "$*" in *toolset-probe*) if [ "$MODE" != reuse ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;; esac
    case "$*" in *toolset-install*) if [ "$MODE" = fail ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;; esac
    echo '{"ExitCode":0,"OOMKilled":false}' ;;
  start) case "$*" in *toolset-install*) if [ "$MODE" = fail ]; then echo 'line one' >&2; echo 'line two' >&2; echo 'npm error code E401' >&2; echo 'npm error 401 Unauthorized' >&2; fi ;; esac ;;
esac
exit 0
`;

interface Fake {
  d: Driver;
  dir: string;
  calls(): string[][];
}

function fake(t: TestContext, mode: string, volumes: string): Fake {
  const dir = tempDir(t);
  writeFileSync(join(dir, "docker"), oracleScript, { mode: 0o755 });
  const d = new Driver(join(dir, "docker"), [
    "PATH=/usr/bin:/bin",
    "MODE=" + mode,
    "VOLUMES=" + volumes,
  ]).withScope({ runID: "RUN", host: "h", pid: 1, deadline: new Date(0) });
  return {
    d,
    dir,
    calls() {
      let data: string;
      try {
        data = readFileSync(join(dir, "calls"), "utf8");
      } catch {
        return [];
      }
      return data
        .split("\x1e")
        .filter((c) => c !== "")
        .map((c) => c.split("\x1f").slice(0, -1));
    },
  };
}

const others =
  "jspf-toolset-VNOW jspf-toolset-vold jspf-toolset-vbusy someone-elses-volume";

const replays: Record<
  string,
  [
    mode: string,
    volumes: string,
    f: (f: Fake, logf: (s: string) => void) => Promise<void>,
  ]
> = {
  "ensure installs": ["install", others, ensureCase("VNOW")],
  "ensure reuses": ["reuse", others, ensureCase("VNOW")],
  "ensure install fails": ["fail", "", ensureCase("VNOW")],
  "ensure gives up on a volume that never gets its labels": [
    "reuse",
    "",
    ensureCase("unlabelled"),
  ],
  "clean other versions": [
    "reuse",
    others,
    async (f, logf) => {
      await cleanOtherVersions(never, {
        docker: f.d,
        cacheDir: join(f.dir, "cache"),
        version: "VNOW",
        logf,
      });
    },
  ],
};

function ensureCase(
  v: string,
): (f: Fake, logf: (s: string) => void) => Promise<void> {
  return async (f, logf) => {
    const vol = await ensure(never, {
      docker: f.d,
      cacheDir: join(f.dir, "cache"),
      version: v,
      image: "node@sha256:img",
      logf,
    });
    logf(`result: ${vol.name} installed=${String(vol.installed)}`);
  };
}

// Ensure and CleanOtherVersions call the docker CLI with the Go build's
// arguments in the Go build's order, and log and fail with its words, so a
// Run of either build fills, finds, holds and removes the same volumes.
for (const want of oracle.cases) {
  test(`Go parity: ${want.name}`, async (t) => {
    const replay = replays[want.name];
    assert.ok(replay, `no replay for ${want.name}`);
    const [mode, volumes, run] = replay;
    const f = fake(t, mode, volumes);
    const logs: string[] = [];
    const logf = (s: string): void => {
      logs.push(s.replaceAll(f.dir, "<cache>"));
    };
    let error = "";
    try {
      await run(f, logf);
    } catch (err) {
      error = (err as Error).message.replaceAll(f.dir, "<cache>");
    }
    assert.equal(error, want.error);
    assert.deepEqual(logs, want.logs);
    assert.deepEqual(f.calls(), want.calls ?? []);
  });
}

test("Go parity: the Helm install script and the toolset volume name", () => {
  assert.equal(helmInstallScript(Helm), oracle.helmScript);
  assert.equal(volumeName(version()), oracle.volumeName);
});

// fakeDocker answers `volume ls` with the given toolset volumes and records
// every `volume rm` in the returned log. `volume rm` of a name that contains
// "busy" fails the way Docker fails for a volume a container uses.
function fakeDocker(
  t: TestContext,
  ...volumes: string[]
): { d: Driver; removals: () => string[] } {
  const dir = tempDir(t);
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
case "$1 $2" in
  "volume ls") printf '%s\\n' ${volumes.map((v) => `'${v}'`).join(" ")} ;;
  "volume rm") echo "$*" >> ${log}
    case "$3" in *busy*) echo 'Error response from daemon: remove x: volume is in use' >&2; exit 1 ;; esac ;;
esac
`,
    { mode: 0o755 },
  );
  const d = new Driver(join(dir, "docker"), undefined).withScope({
    runID: "r",
    host: "h",
    pid: 1,
    deadline: new Date(Date.now() + 3_600_000),
  });
  return {
    d,
    removals() {
      try {
        return readFileSync(log, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

// Spec: the Run removes the toolset volumes of other toolset versions at its
// start, not only when a Check that uses the toolset is about to run.
test("other toolset versions are removed at start but never the current one", async (t) => {
  const { d, removals } = fakeDocker(
    t,
    volumeName("v-now"),
    volumeName("v-old"),
    volumeName("v-busy"),
    "someone-elses-volume",
  );

  await cleanOtherVersions(never, {
    docker: d,
    cacheDir: tempDir(t),
    version: "v-now",
  });

  const got = removals().join("\n");
  assert.ok(got.includes("volume rm " + volumeName("v-old")), got);
  assert.ok(!got.includes(volumeName("v-now")), got);
  assert.ok(!got.includes("someone-elses-volume"), got);
});

// Another Run may be filling a volume right now, under the same lock. The
// start does not wait for it and does not remove anything then.
test("the cleanup at start leaves everything while another Run holds the toolset lock", async (t) => {
  const { d, removals } = fakeDocker(
    t,
    volumeName("v-now"),
    volumeName("v-old"),
  );
  const cache = tempDir(t);
  const held = await acquire(never, join(cache, "toolset.lock"));
  t.after(() => {
    held.release();
  });
  const logs: string[] = [];

  const started = Date.now();
  await cleanOtherVersions(never, {
    docker: d,
    cacheDir: cache,
    version: "v-now",
    logf: (s) => logs.push(s),
  });

  assert.ok(Date.now() - started < 15_000, "the cleanup waited for the lock");
  assert.deepEqual(removals(), []);
  assert.deepEqual(logs, [
    "not cleaning up old toolset volumes now: the toolset lock is busy",
  ]);
});
