// Folders and files for tests. Every test module that needs a temporary
// folder or a tree of files takes them from here.

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

/**
 * tempDir makes a new empty folder, with symbolic links in its own path
 * resolved, and removes it when the test ends.
 */
export function tempDir(t: TestContext, prefix = "jspf-test-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * writeFiles writes files (path -> content) below root and makes the parent
 * folders as needed. An existing file is replaced.
 */
export function writeFiles(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}
