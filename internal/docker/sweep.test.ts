import assert from "node:assert/strict";
import { test } from "node:test";

import { never, recordingCLI } from "./docker.testutil.ts";
import { Driver } from "./driver.ts";
import { goneAlready } from "./sweep.ts";

// One abandoned resource of this Run and one of another Run per kind, then
// the resources whose labels are unreadable or still alive.
function listing(id: string): string {
  // id | run id | host | pid | deadline
  return [
    `echo "${id}-own|RUN-SELF|h|1|2020-01-01T00:00:00Z"`,
    `echo "${id}-other|RUN-OTHER|h|1|2020-01-01T00:00:00Z"`,
    `echo "${id}-alive|RUN-ALIVE|h|1|2999-01-01T00:00:00Z"`,
    `echo "${id}-deadpid|RUN-DEAD|h|77|2999-01-01T00:00:00Z"`,
    `echo "${id}-elsewhere|RUN-AWAY|other-host|77|2999-01-01T00:00:00Z"`,
    `echo "${id}-unreadable|RUN-X|h|not-a-pid|yesterday"`,
    `echo "${id}-short|RUN-X|h|1"`,
  ].join("; ");
}

// The sweep must never remove what belongs to the Run that sweeps, even when
// its labels say it is abandoned. This is tested against a fake docker CLI, so
// no other process sharing a real daemon can interfere.
test("the sweep spares the resources of its own Run", async () => {
  const rec = recordingCLI(`case "$1 $2" in
  "ps --all") ${listing("c")} ;;
  "network ls") ${listing("n")} ;;
  "volume ls") ${listing("v")} ;;
esac
`);
  const d = new Driver(rec.exe, undefined).withScope({
    runID: "RUN-SELF",
    host: "h",
    pid: 42,
    deadline: new Date(Date.now() + 3_600_000),
  });

  const { removed, error } = await d.sweepLeftovers(
    never,
    new Date(),
    "h",
    (pid) => pid !== 77,
  );

  assert.equal(error, undefined);
  assert.deepEqual(removed, [
    "c-other",
    "c-deadpid",
    "n-other",
    "n-deadpid",
    "v-other",
    "v-deadpid",
  ]);
  const removals = rec.lines().filter((l) => l.includes("rm "));
  assert.deepEqual(removals, [
    "rm --force --volumes c-other",
    "rm --force --volumes c-deadpid",
    "network rm n-other",
    "network rm n-deadpid",
    "volume rm --force v-other",
    "volume rm --force v-deadpid",
  ]);
});

test("a sweep that cannot remove one leftover still removes the rest and says why", async () => {
  const rec = recordingCLI(`case "$1 $2" in
  "ps --all") echo "c1|R1|h|1|2020-01-01T00:00:00Z"; echo "c2|R2|h|1|2020-01-01T00:00:00Z"; echo "c3|R3|h|1|2020-01-01T00:00:00Z" ;;
  "rm --force") case "$4" in
      c1) echo "Error response from daemon: No such container: c1" >&2; exit 1 ;;
      c2) echo "Error response from daemon: cannot remove c2: device busy" >&2; exit 1 ;;
    esac ;;
esac
`);
  const d = new Driver(rec.exe, undefined).withScope({
    runID: "SELF",
    host: "h",
    pid: 1,
    deadline: new Date(),
  });
  const { removed, error } = await d.sweepLeftovers(never, new Date(), "h");
  assert.deepEqual(removed, ["c3"]);
  assert.equal(
    error?.message,
    "removing leftover container c2: docker rm --force failed (exit 1): Error response from daemon: cannot remove c2: device busy",
  );
});

test("a removal that only finds the resource gone counts as done", () => {
  for (const m of [
    "docker network rm failed (exit 1): Error response from daemon: network abc not found",
    "docker volume rm failed (exit 1): Error response from daemon: get abc: No such volume: abc",
    "docker rm failed (exit 1): Error response from daemon: No such container: abc",
  ]) {
    assert.equal(goneAlready(new Error(m)), true, m);
  }
  for (const m of [
    "docker network rm failed (exit 1): Error response from daemon: network abc has active endpoints",
    "docker volume rm failed (exit 1): Error response from daemon: remove abc: volume is in use",
  ]) {
    assert.equal(goneAlready(new Error(m)), false, m);
  }
});
