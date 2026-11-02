import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { preflightDocker } from "./preflight.ts";

interface Recorded {
  name: string;
  script: string | null;
  lastStderrLine: string;
  exitCode: number;
}

const fixture = JSON.parse(
  readFileSync(new URL("testdata/go-preflight.json", import.meta.url), "utf8"),
) as { cases: Recorded[] };

function fakeBin(script: string | null): string {
  const bin = mkdtempSync(join(tmpdir(), "jspf-preflight-"));
  if (script !== null) {
    writeFileSync(join(bin, "docker"), script, { mode: 0o755 });
  }
  return bin;
}

// The Go build's messages and exit codes for a Docker setup that cannot work,
// recorded from the frozen build in testdata/go-preflight.json.
for (const c of fixture.cases) {
  test(`docker setup failure as in Go: ${c.name}`, async () => {
    const bin = fakeBin(c.script);
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on("data", (p: Buffer) => chunks.push(p));

    const got = await preflightDocker(
      (k) => (k === "PATH" ? bin : ""),
      new AbortController().signal,
      stderr,
    );

    assert.equal(got, c.exitCode);
    assert.equal(Buffer.concat(chunks).toString(), c.lastStderrLine + "\n");
  });
}

test("an interrupt during the Docker check exits 130", async () => {
  const bin = fakeBin("#!/bin/sh\nexec /bin/sleep 30\n");
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stderr.on("data", (p: Buffer) => chunks.push(p));
  const ac = new AbortController();
  setTimeout(() => {
    ac.abort();
  }, 200);

  const got = await preflightDocker(
    (k) => (k === "PATH" ? bin : ""),
    ac.signal,
    stderr,
  );

  assert.equal(got, 130);
  assert.equal(
    Buffer.concat(chunks).toString(),
    "js-prueffactory: interrupted\n",
  );
});

test("a reachable daemon gives the Driver and its facts", async () => {
  const bin = fakeBin(`#!/bin/sh
case "$1" in
  info) echo '{"ServerVersion":"29.4.0","NCPU":8,"MemTotal":17179869184,"OSType":"linux","Architecture":"aarch64"}' ;;
  version) echo '{"ApiVersion":"1.41"}' ;;
esac
`);
  const got = await preflightDocker(
    (k) => (k === "PATH" ? bin : ""),
    new AbortController().signal,
    new PassThrough(),
  );
  assert.ok(typeof got === "object");
  assert.equal(got.info.apiVersion, "1.41");
  assert.equal(got.base.name("x"), "jspf--x");
});
