// Go: advisorydb_test.go, and the Go recording of EnsureAdvisoryDB with a
// fake docker CLI (testdata/go-oracle-advisorydb.go.txt).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Driver } from "../docker/driver.ts";
import { formatTime } from "../gocompat/json.ts";
import { quote } from "../gocompat/fmt.ts";
import {
  ensureAdvisoryDB,
  formatDBDate,
  needsRefresh,
  parseDBDate,
} from "./advisorydb.ts";
import { tempDir } from "../testkit/fs.testutil.ts";

interface OracleCase {
  name: string;
  mode: string;
  date: string;
  now: string;
  error: string;
  result: string;
  logs: string[];
  calls: string[][] | null;
}

interface DateCase {
  in: string;
  ok: boolean;
  utc: string;
  needsRefresh: boolean;
}

const oracle = JSON.parse(
  readFileSync(
    new URL("testdata/go-oracle-advisorydb.json", import.meta.url),
    "utf8",
  ),
) as { cases: OracleCase[]; dates: DateCase[] };

const never = new AbortController().signal;

// The fake docker CLI of the Go recording, word for word.
const oracleScript = `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "$(dirname "$0")/calls"
printf '\\036' >> "$(dirname "$0")/calls"
case "$1 $2" in
  "volume inspect") echo osv-db; exit 0 ;;
esac
case "$1" in
  inspect)
    case "$*" in
      *advisorydb-probe*) if [ -z "$DATE" ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;;
      *advisorydb-clear*) if [ "$MODE" = clear ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;;
      *advisorydb-download*) if [ "$MODE" = download ]; then echo '{"ExitCode":2,"OOMKilled":false}'; exit 0; fi
        if [ "$MODE" = vulns ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;;
      *advisorydb-swap*) if [ "$MODE" = swap ]; then echo '{"ExitCode":1,"OOMKilled":false}'; exit 0; fi ;;
    esac
    echo '{"ExitCode":0,"OOMKilled":false}' ;;
  start)
    case "$*" in
      *advisorydb-probe*) printf '%s' "$DATE" ;;
      *advisorydb-clear*) if [ "$MODE" = clear ]; then echo 'rm: cannot remove' >&2; fi ;;
      *advisorydb-download*) if [ "$MODE" = download ]; then printf 'one\\ntwo\\nthree\\nfour: no route to host\\n' >&2; fi ;;
      *advisorydb-swap*) if [ "$MODE" = swap ]; then echo 'mv: cannot stat' >&2; fi ;;
    esac ;;
esac
exit 0
`;

// The volume, the download date, the refresh flag and the warning appear in
// the Report and in every later Run's decision. ensureAdvisoryDB calls the
// docker CLI with the Go build's arguments in the Go build's order and logs
// and fails with its words, so a database either build downloaded is the
// other's too.
for (const want of oracle.cases) {
  test(`Go parity: ${want.name}`, async (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "docker"), oracleScript, { mode: 0o755 });
    const d = new Driver(join(dir, "docker"), [
      "PATH=/usr/bin:/bin",
      "MODE=" + want.mode,
      "DATE=" + want.date,
    ]).withScope({ runID: "RUN", host: "h", pid: 1, deadline: new Date(0) });
    const logs: string[] = [];
    let error = "";
    let result = "";
    try {
      const db = await ensureAdvisoryDB(never, {
        docker: d,
        cacheDir: join(dir, "cache"),
        scanner: "osv@sha256:scanner",
        helper: "alpine@sha256:helper",
        now: () => new Date(want.now),
        logf: (s) => logs.push(s.replaceAll(dir, "<cache>")),
      });
      result = `${db.name} ${formatTime(db.date)} refreshed=${String(db.refreshed)} warning=${quote(db.warning)}`;
    } catch (err) {
      error = (err as Error).message.replaceAll(dir, "<cache>");
    }
    assert.equal(error, want.error);
    assert.equal(result, want.result);
    assert.deepEqual(logs, want.logs);
    let calls: string[][] = [];
    try {
      calls = readFileSync(join(dir, "calls"), "utf8")
        .split("\x1e")
        .filter((c) => c !== "")
        .map((c) => c.split("\x1f").slice(0, -1));
    } catch {
      // no call at all
    }
    assert.deepEqual(calls, want.calls ?? []);
  });
}

test("Go parity: the date file is read as Go's time.Parse(time.RFC3339) reads it", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  for (const c of oracle.dates) {
    const got = parseDBDate(c.in);
    assert.equal(got !== null, c.ok, JSON.stringify(c.in));
    if (got !== null) {
      // A Date holds milliseconds; Go keeps nanoseconds.
      assert.equal(
        formatTime(got),
        c.utc.replace(/(\.\d{3})\d+Z$/, "$1Z"),
        c.in,
      );
    }
    assert.equal(needsRefresh(got, now), c.needsRefresh, JSON.stringify(c.in));
  }
});

test("the advisory database is refreshed when older than twenty-four hours", () => {
  // Go: TestTheAdvisoryDatabaseIsRefreshedWhenOlderThanTwentyFourHours
  const now = new Date("2026-10-26T12:00:00Z");
  for (const [name, date, want] of [
    ["an hour old", "2026-10-26T11:00:00Z", false],
    ["exactly 24 hours old", "2026-10-25T12:00:00Z", false],
    ["a second over 24 hours", "2026-10-25T11:59:59Z", true],
    ["a week old", "2026-10-19T12:00:00Z", true],
    ["no date at all", "", true],
    ["a date nobody can read", "yesterday", true],
    ["a date in the future", "2026-10-27T12:00:00Z", true],
  ] as const) {
    assert.equal(needsRefresh(parseDBDate(date), now), want, name);
  }
});

test("the database date round-trips through its marker file", () => {
  // Go: TestTheDatabaseDateRoundTripsThroughItsMarkerFile
  const d = new Date("2026-10-26T08:30:15Z");
  assert.equal(parseDBDate(formatDBDate(d) + "\n")?.getTime(), d.getTime());
});

test("a long hostile date file is read in linear time", () => {
  const start = performance.now();
  for (const s of [
    "2026-10-26T11:00:00." + "1".repeat(1 << 20),
    "2026-10-26T11:00:00." + "1".repeat(1 << 20) + "x",
    " ".repeat(1 << 20) + "x",
  ]) {
    parseDBDate(s);
  }
  assert.ok(performance.now() - start < 2000);
});
