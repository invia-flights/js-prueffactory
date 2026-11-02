// readGoBuild reads the version control stamp that `go build` writes into a
// binary built from a git checkout (what `go version -m` shows), without
// needing a Go toolchain.
import { readFile } from "node:fs/promises";

export interface GoBuild {
  // The commit the binary was built from, or undefined without a stamp.
  revision: string | undefined;
  // Whether the checkout had uncommitted changes.
  modified: boolean;
}

export async function readGoBuild(file: string): Promise<GoBuild> {
  const text = (await readFile(file)).toString("latin1");
  const revision = /\tvcs\.revision=([0-9a-f]{40})\n/.exec(text)?.[1];
  const modified = text.includes("\tvcs.modified=true\n");
  return { revision, modified };
}
