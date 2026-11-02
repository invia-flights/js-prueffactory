// Test helpers shared by the Discovery tests: temp projects written from a
// path -> content table, as the Go tests' project helper does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

import { discover, type File, type Project } from "./discovery.ts";

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

// writeFiles writes files (path -> content) below root.
export function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

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
