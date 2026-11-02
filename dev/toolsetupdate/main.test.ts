import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { fakeServer, oracle } from "./fakeserver.testutil.ts";
import { liveSources, run } from "./main.ts";
import type { Sources } from "./update.ts";
import {
  allNew,
  newDigest,
  oldDigest,
  tableSource,
  writeTable,
} from "./update.testutil.ts";

class Capture extends Writable {
  text = "";
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    this.text += chunk.toString("utf8");
    done();
  }
}

async function call(
  args: string[],
  src: Sources,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run(
    new AbortController().signal,
    args,
    stdout,
    stderr,
    src,
  );
  return { code, stdout: stdout.text, stderr: stderr.text };
}

// Go: TestTheCommandRewritesTheTableAndListsTheChanges.
test("the command rewrites the table and lists the changes", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const r = await call(["-dir", dir], allNew());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /node:24\.1\.0: /);
  assert.ok(r.stdout.includes(newDigest), r.stdout);
  assert.ok(
    !readFileSync(join(dir, "tool.ts"), "utf8").includes(oldDigest),
    "the table still has the old digests",
  );
});

// Go: TestTheCommandInDryRunModeLeavesTheTableAlone.
test("the command in dry-run mode leaves the table alone", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const r = await call(["-dry-run", "-dir", dir], allNew());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "tool.ts"), "utf8"), tableSource);
});

// Go: TestTheCommandFailsWithExitCode1WhenAnImageIsRefused.
test("the command fails with exit code 1 when an image is refused", async (t) => {
  const dir = writeTable(t, "tool.ts", tableSource);
  const src = allNew();
  src.refused.set("node:24.1.0", "has no linux/arm64 entry in its index");
  const r = await call(["-dir", dir], src);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /arm64/);
});

const here = fileURLToPath(new URL(".", import.meta.url));

// The Go oracle ran the Go command on the Go table with recorded registry
// answers; the TypeScript command on the TypeScript table must plan the same
// changes in the same order, file names ending in .ts instead of .go.
describe("the command plans what the Go command planned", () => {
  for (const c of oracle.runs) {
    test(c.name, async (t) => {
      const fetch = await fakeServer(t, { manifests: c.manifests });
      const src = liveSources(fetch);
      const args = c.args.map((a, i) =>
        c.args[i - 1] === "-dir" ? join(here, a) : a,
      );
      const r = await call(args, src);
      assert.equal(r.code, c.exitCode);
      assert.equal(r.stdout, c.stdout.replace(/^(\w+)\.go: /gm, "$1.ts: "));
      assert.equal(r.stderr, c.stderr);
    });
  }
});
