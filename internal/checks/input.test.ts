import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Project } from "../discovery/discovery.ts";
import { tempDir, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { maxProjectFileBytes } from "./readcap.ts";

test("fileSHA256 streams huge files and never follows links", (t) => {
  // Go: TestFileSHA256StreamsHugeFilesAndNeverFollowsLinks
  const huge = "y".repeat(maxProjectFileBytes + 1);
  const dir = writeTree(t, { "huge.bin": huge });
  const outside = join(tempDir(t), "outside.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(dir, "link.txt"));
  const input = new Input({
    project: new Project(dir),
    context: null as never,
    snapshotDir: dir,
  });

  const want = createHash("sha256").update(huge).digest("hex");
  assert.equal(input.fileSHA256("huge.bin"), want);
  assert.equal(input.fileSHA256("huge.bin"), want, "the cached answer");
  assert.equal(input.fileSHA256("link.txt"), "");
  assert.equal(input.fileSHA256("missing.js"), "");
});

test("location and reproduction", (t) => {
  const dir = writeTree(t, { "a.js": "x\n" });
  const input = new Input({
    project: new Project(dir),
    context: null as never,
    snapshotDir: dir,
    originalPath: "/work/demo",
  });
  const loc = input.location("primary", "a.js", 3, 0);
  assert.deepEqual(loc.start, { line: 3, column: null });
  assert.equal(loc.path_base, "project_root");
  assert.equal(loc.file_sha256.length, 64);
  assert.equal(input.location("primary", "a.js", 0, 5).start, null);
  assert.deepEqual(input.reproduction("x.y"), {
    rerun_command: ["js-prueffactory", "test", "/work/demo", "--only", "x.y"],
    test: null,
    verified_by: ["x.y"],
  });
});
