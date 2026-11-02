// Shared by the Snapshot tests.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import type { TestContext } from "node:test";

import { take } from "./snapshot.ts";
import type { Options, Snapshot } from "./snapshot.ts";

// tempDir returns a new folder with symbolic links in its own path resolved,
// removed after the test.
export function tempDir(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-")));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// write creates a file below root, making parent folders as needed, and
// sets its mode exactly (the umask does not apply).
export function write(
  root: string,
  rel: string,
  content: string,
  mode = 0o644,
): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  chmodSync(p, mode);
}

export function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function takeIn(
  t: TestContext,
  root: string,
  opts: Options = {},
): Snapshot {
  return take(root, join(tempDir(t), "copy"), opts);
}

// limitedPaths maps each Limitation's path to its code.
export function limitedPaths(s: Snapshot): Map<string, string> {
  return new Map(s.limitations.map((l) => [l.path, l.code]));
}

// tarOf is the archive Snapshot.writeTar writes.
export async function tarOf(s: Snapshot): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await s.writeTar(
    new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  return Buffer.concat(chunks);
}
