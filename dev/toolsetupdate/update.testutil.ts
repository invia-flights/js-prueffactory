import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { tempDir } from "../../internal/cli/cli.testutil.ts";
import type { Sources } from "./update.ts";

/** FakeSources answers from maps and records what was asked. */
export class FakeSources implements Sources {
  digests = new Map<string, string>(); // "repo:tag" -> digest
  refused = new Map<string, string>(); // "repo:tag" -> reason
  checksums = new Map<string, string>(); // archive URL -> sha256
  fileSums = new Map<string, string>(); // plain file URL -> sha256 of its content
  asked: string[] = [];

  imageDigest(
    _signal: AbortSignal,
    repo: string,
    tag: string,
  ): Promise<string> {
    const key = `${repo}:${tag}`;
    this.asked.push(key);
    const why = this.refused.get(key);
    if (why !== undefined) {
      return Promise.reject(new Error(`${key}: ${why}`));
    }
    return answer(this.digests, key);
  }

  checksum(_signal: AbortSignal, archiveURL: string): Promise<string> {
    this.asked.push(archiveURL);
    return answer(this.checksums, archiveURL);
  }

  fileChecksum(_signal: AbortSignal, fileURL: string): Promise<string> {
    this.asked.push(fileURL);
    return answer(this.fileSums, fileURL);
  }
}

function answer(m: Map<string, string>, key: string): Promise<string> {
  const v = m.get(key);
  return v === undefined
    ? Promise.reject(new Error(`${key}: unknown to the fake`))
    : Promise.resolve(v);
}

export const oldDigest = "sha256:" + "1".repeat(64);
export const newDigest = "sha256:" + "2".repeat(64);
export const oldSum = "a".repeat(64);
export const newSum = "b".repeat(64);

// A table that spells its entries the ways the real one does: a plain Image
// constant, an Image inside a PinnedTool, Image literals in a Map, and a
// download with a checksum; one value in single quotes and one in a template
// literal.
export const tableSource = `import type { Image, PinnedTool } from "./toolset.ts";

// tool is pinned by the digest of its index.
export const tool: PinnedTool = {
  name: "tool",
  version: "1.0.0",
  image: { repo: "vendor/tool", tag: "v1.0.0", digest: "${oldDigest}" },
};

export const base: Image = {
  repo: "ghcr.io/vendor/base",
  tag: "3.1",
  digest:
    "${oldDigest}",
};

const images = new Map<string, Image>([
  ["24/debian", { repo: "node", tag: "24.1.0", digest: "${oldDigest}" }],
  ["24/alpine", { repo: "node", tag: "24.1.0-alpine", digest: '${oldDigest}' }],
]);

export const bin = {
  version: "3.1.0",
  downloads: new Map([
    [
      "amd64",
      {
        url: "https://example.test/bin-v3.1.0-linux-amd64.tar.gz",
        sha256: \`${oldSum}\`,
      },
    ],
  ]),
};
`;

/** writeTable writes one table file into a new folder and returns the folder. */
export function writeTable(
  t: TestContext,
  name: string,
  content: string,
): string {
  const dir = tempDir(t);
  writeFileSync(join(dir, name), content);
  return dir;
}

/** allNew answers a new value for every pin of tableSource. */
export function allNew(): FakeSources {
  const f = new FakeSources();
  f.digests = new Map([
    ["vendor/tool:v1.0.0", newDigest],
    ["ghcr.io/vendor/base:3.1", newDigest],
    ["node:24.1.0", newDigest],
    ["node:24.1.0-alpine", newDigest],
  ]);
  f.checksums = new Map([
    ["https://example.test/bin-v3.1.0-linux-amd64.tar.gz", newSum],
  ]);
  return f;
}
