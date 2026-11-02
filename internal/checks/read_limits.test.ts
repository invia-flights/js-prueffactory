// Native Checks never read a file bigger than maxProjectFileBytes into memory
// and name what they left out (Go: read_limits_test.go).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import { StatusCompleted } from "../resultset/types.ts";
import "./all.ts";
import {
  projectContext,
  runCheck,
  tempDir,
  writeTree,
} from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { sha256File } from "./readcap.ts";

/** hugeFile is bigger than any project file a native Check reads into memory. */
const hugeFile = 20 << 20;

function hasLimitationFor(res: Result, code: string, path: string): boolean {
  return (res.limitations ?? []).some(
    (l) => l.reason_code === code && l.message.includes(path),
  );
}

async function runOn(id: string, dir: string): Promise<Result> {
  const proj = discover(dir);
  return runCheck(
    id,
    new Input({
      project: proj,
      context: projectContext(proj),
      snapshotDir: dir,
      originalPath: dir,
    }),
  );
}

test("a huge file is left unread by artifacts.structured and named in a Limitation", async (t) => {
  // If the Check read it, "{" would be a parse Finding.
  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "data/huge.json": "{" + " ".repeat(hugeFile),
  });

  const res = await runOn("artifacts.structured", dir);

  assert.equal(res.status, StatusCompleted, res.reason);
  assert.equal(res.findings?.length ?? 0, 0);
  assert.ok(
    hasLimitationFor(res, "files_too_large_to_read", "data/huge.json"),
    JSON.stringify(res.limitations),
  );
});

test("a huge file is left uncounted by quality.size and quality.suppressions and named in a Limitation", async (t) => {
  const dir = writeTree(t, {
    "package.json": '{"name":"x"}',
    "src/a.js": "a\nb\n",
    "src/huge.js": "x\n".repeat(hugeFile / 2),
  });
  for (const id of ["quality.size", "quality.suppressions"]) {
    const res = await runOn(id, dir);
    assert.equal(res.status, StatusCompleted, `${id}: ${res.reason ?? ""}`);
    assert.ok(
      hasLimitationFor(res, "files_too_large_to_read", "src/huge.js"),
      `${id}: ${JSON.stringify(res.limitations)}`,
    );
  }
  const size = await runOn("quality.size", dir);
  assert.equal(
    size.metrics?.find((m) => m.name === "lines.file_class:source")?.value,
    3,
    "package.json 1, a.js 2; the huge file not counted",
  );
});

test("sha256File streams huge files and never follows links", (t) => {
  const dir = writeTree(t, { "huge.bin": "y".repeat(hugeFile) });
  const outside = join(tempDir(t), "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(dir, "link.txt"));

  const want = createHash("sha256").update("y".repeat(hugeFile)).digest("hex");
  assert.equal(sha256File(join(dir, "huge.bin")), want);
  assert.equal(
    sha256File(join(dir, "huge.bin")),
    want,
    "second call (cached) returns the same",
  );
  assert.equal(
    sha256File(join(dir, "link.txt")),
    "",
    "through a symbolic link",
  );
});
