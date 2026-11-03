// Test helpers shared by the Discovery tests: temp projects written from a
// path -> content table, as the Go tests' project helper does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { discover, type File, type Project } from "./discovery.ts";
import { writeFiles } from "../testkit/fs.testutil.ts";

const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// tempDir returns a new empty folder that is removed after the tests.
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "discovery-"));
  temps.push(d);
  return d;
}

export { writeFiles };

// project writes files below a new temp folder and discovers it.
export function project(files: Readonly<Record<string, string>>): Project {
  const root = tempDir();
  writeFiles(root, files);
  return discover(root);
}

export function fileOf(p: Project, path: string): File {
  const f = p.files.find((x) => x.path === path);
  assert.ok(
    f,
    `${path} not discovered; have ${p.files.map((x) => x.path).join(", ")}`,
  );
  return f;
}
