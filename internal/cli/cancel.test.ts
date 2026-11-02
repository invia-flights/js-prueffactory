import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { call, project, runMain, tempDir } from "./cli.testutil.ts";
import { hardStop, withInterrupts } from "./interrupt.ts";

// Seam A without a real daemon: nothing is copied before Docker answers, and
// an interrupt before anything started exits 130 (Go: cancel_test.go and the
// "before any file is copied" tests of cli_test.go).

function fakeDocker(t: TestContext, script: string): string {
  const bin = tempDir(t);
  writeFileSync(join(bin, "docker"), script, { mode: 0o755 });
  return bin;
}

// assertUntouched checks that nothing was copied into tmp or written under state.
function assertUntouched(tmp: string, state: string): void {
  assert.deepEqual(readdirSync(tmp), [], "the temporary folder is not empty");
  assert.ok(!existsSync(state), "the report folder tree was created");
}

function env(t: TestContext, path: string) {
  const tmp = tempDir(t);
  const state = join(tempDir(t), "state");
  return {
    tmp,
    state,
    env: { PATH: path, TMPDIR: tmp, XDG_STATE_HOME: state },
  };
}

test("a missing docker CLI exits 3 before any file is copied", async (t) => {
  // Go: TestMissingDockerCLIExitsThreeBeforeAnyFileIsCopied
  const dir = project(t);
  const e = env(t, tempDir(t));
  const r = await call(e.env, "test", dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /docker CLI/);
  assertUntouched(e.tmp, e.state);
});

test("an unreachable daemon exits 3 before any file is copied", async (t) => {
  // Go: TestUnreachableDaemonExitsThreeBeforeAnyFileIsCopied
  const dir = project(t);
  const bin = fakeDocker(
    t,
    "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?' >&2\nexit 1\n",
  );
  const e = env(t, bin);
  const r = await call(e.env, "test", dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /Docker daemon/);
  assert.equal(r.stdout, "");
  assertUntouched(e.tmp, e.state);
});

test("a daemon with a too old API exits 3 before any file is copied", async (t) => {
  // Go: TestADaemonWithATooOldAPIExitsThreeBeforeAnyFileIsCopied
  const dir = project(t);
  const bin = fakeDocker(
    t,
    `#!/bin/sh
case "$1" in
  info) echo '{"ServerVersion":"19.03.0","NCPU":2,"MemTotal":1073741824,"OSType":"linux","Architecture":"x86_64"}' ;;
  version) echo '{"Version":"19.03.0","ApiVersion":"1.40","MinAPIVersion":"1.12"}' ;;
esac
`,
  );
  const e = env(t, bin);
  const r = await call(e.env, "test", dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /API/);
  assert.match(r.stderr, /1\.40/);
  assert.equal(r.stdout, "");
  assertUntouched(e.tmp, e.state);
});

test("an interrupt before anything started exits 130 without leaving files", async (t) => {
  // Go: TestAnInterruptBeforeAnythingStartedExitsOneThirtyWithoutLeavingFiles
  const dir = project(t);
  const bin = fakeDocker(t, "#!/bin/sh\nsleep 30\n");
  const e = env(t, bin);
  const ctl = new AbortController();
  ctl.abort();
  const r = await runMain(["test", dir], { env: e.env, signal: ctl.signal });
  assert.equal(r.exitCode, 130);
  assert.equal(
    r.stderr.toString().endsWith("js-prueffactory: interrupted\n"),
    true,
  );
  assertUntouched(e.tmp, e.state);
});

// isAborted reads the flag through a call, so that TypeScript does not keep
// its value from before the interrupt.
const isAborted = (s: AbortSignal): boolean => s.aborted;

test("the first interrupt cancels, the second is the hard stop, later ones change nothing", () => {
  // Go: WithInterrupts (interrupt.go), driven as the cancel Docker tests do.
  const i = withInterrupts();
  const hard = hardStop(i.signal);
  assert.ok(hard !== null);
  assert.ok(!i.signal.aborted && !hard.aborted);
  i.interrupt();
  assert.ok(isAborted(i.signal) && !isAborted(hard));
  i.interrupt();
  assert.ok(isAborted(hard));
  i.interrupt();
  assert.equal(hardStop(new AbortController().signal), null);

  const stopped = withInterrupts();
  stopped.stop();
  stopped.interrupt();
  stopped.interrupt();
  assert.ok(hardStop(stopped.signal)?.aborted === false);
});
