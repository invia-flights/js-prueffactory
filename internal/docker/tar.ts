import { posix } from "node:path";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";

import { quote } from "../gostrings/quote.ts";
import { TarWriter } from "../tarwriter/tarwriter.ts";
import { byteOrder } from "./common.ts";

// File is a file copied into a container before it starts.
export interface File {
  readonly path: string; // absolute path inside the container
  readonly mode?: number; // 0o644 when unset or 0
  readonly content: Uint8Array;
}

// tarFiles packs files into a tar archive rooted at "/", with the parent
// folders as explicit entries and everything owned by root.
export async function tarFiles(files: readonly File[]): Promise<Buffer> {
  const sorted = [...files].sort((a, b) => byteOrder(a.path, b.path));
  for (const f of sorted) {
    if (!f.path.startsWith("/")) {
      throw new Error(`container path ${quote(f.path)} is not absolute`);
    }
  }
  const out = new PassThrough();
  const bytes = buffer(out);
  const tw = new TarWriter(out);
  const dirs = new Set<string>();
  for (const f of sorted) {
    const name = posix
      .normalize(f.path)
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const parents: string[] = [];
    for (
      let dir = posix.dirname(name);
      dir !== "." && dir !== "/";
      dir = posix.dirname(dir)
    ) {
      parents.unshift(dir);
    }
    for (const dir of parents) {
      if (dirs.has(dir)) {
        continue;
      }
      dirs.add(dir);
      await tw.writeHeader({ type: "directory", name: dir + "/", mode: 0o755 });
    }
    await tw.writeHeader({
      type: "file",
      name,
      mode: f.mode !== undefined && f.mode !== 0 ? f.mode : 0o644,
      size: f.content.length,
    });
    await tw.write(f.content);
  }
  await tw.close();
  return bytes;
}
