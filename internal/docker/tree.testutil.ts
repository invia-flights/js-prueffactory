// File trees for the tar parity test (tar.docker.test.ts): a synthetic tree
// with what the test projects lack (executable files, long names, non-ASCII
// names, links to folders), and a walker that writes a tree as a tar stream
// the way Go's Snapshot.WriteTar does.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";

import { TarWriter } from "../tarwriter/tarwriter.ts";

// buildSyntheticTree fills the empty folder dir. The Go listing in
// testdata/go-volume-files.json was recorded from exactly this tree.
export function buildSyntheticTree(dir: string): void {
  const file = (rel: string, content: string, mode = 0o644): void => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    chmodSync(p, mode);
  };
  file("bin/run.sh", "#!/bin/sh\necho hi\n", 0o755);
  file("bin/owner-only", "x\n", 0o700);
  file("private.txt", "secret-ish\n", 0o600);
  file("empty.txt", "");
  file("ä-ö/ü.txt", "unicode\n");
  file(
    "deep/" + "segment-of-a-long-path-0123456789/".repeat(4) + "file.txt",
    "deep\n",
  );
  file("long-name-" + "x".repeat(110) + ".txt", "long\n");
  mkdirSync(join(dir, "empty-dir"));
  symlinkSync("bin/run.sh", join(dir, "link-to-run"));
  symlinkSync("deep", join(dir, "dir-link"));
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// writeTreeTar writes root as Go's Snapshot.WriteTar writes a Snapshot: entries
// in lexical order, folders 0755, files 0644 or 0755 by the owner's execute
// bit, links with their target, and links that resolve outside root left out
// (the Snapshot does not take them). It stands in for the Snapshot's own
// writer, which ticket 08 of the port brings.
export async function writeTreeTar(root: string, w: Writable): Promise<void> {
  const realRoot = realpathSync(root);
  const tw = new TarWriter(w);
  const walk = async (dir: string): Promise<void> => {
    const names = readdirSync(dir).sort(byteOrder);
    for (const n of names) {
      const p = join(dir, n);
      const name = relative(root, p).split(sep).join("/");
      const st = statSync(p, { throwIfNoEntry: true });
      const lst = readlinkOrUndefined(p);
      if (lst !== undefined) {
        const target = resolve(dirname(p), lst);
        let real: string;
        try {
          real = realpathSync(target);
        } catch {
          continue;
        }
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          continue;
        }
        await tw.writeHeader({
          type: "symlink",
          name,
          mode: 0o777,
          linkname: lst,
        });
      } else if (st.isDirectory()) {
        await tw.writeHeader({
          type: "directory",
          name: name + "/",
          mode: 0o755,
        });
        await walk(p);
      } else if (st.isFile()) {
        const data = readFileSync(p);
        await tw.writeHeader({
          type: "file",
          name,
          mode: (st.mode & 0o100) !== 0 ? 0o755 : 0o644,
          size: data.length,
        });
        await tw.write(data);
      }
    }
  };
  await walk(root);
  await tw.close();
}

function readlinkOrUndefined(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}
