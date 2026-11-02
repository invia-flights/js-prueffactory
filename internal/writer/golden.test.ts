import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { sortStrings } from "../gocompat/strings.ts";
import { goldenScored } from "../resultset/helpers.testutil.ts";
import { golden } from "../resultset/resultsettest/golden.testutil.ts";
import type { Set } from "../resultset/types.ts";
import { FileName } from "../schema/schema.ts";
import { write } from "./writer.ts";

// The golden report folders: what the writer makes of fixed result sets. They
// were written by the Go build and are shared by both builds.
//
// UPDATE_GOLDEN=1 rewrites them from the TypeScript build:
//   UPDATE_GOLDEN=1 node --test internal/writer/golden.test.ts
// (npm run test:golden-update). Review git diff internal/writer/testdata/golden
// before committing. The benchmark folders are scored by the TypeScript
// scorer, so their Benchmark section and fingerprint are compared too.
const update = process.env.UPDATE_GOLDEN === "1";

const goldenRoot = fileURLToPath(new URL("testdata/golden/", import.meta.url));

// files returns every file below dir as a slash-separated relative path,
// except the schema, which the schema package owns.
function files(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of entries) {
    const slash = rel.split(sep).join("/");
    if (statSync(join(dir, rel)).isFile() && slash !== FileName) {
      out.push(slash);
    }
  }
  return sortStrings(out);
}

function goldenSets(): Record<string, Set> {
  return {
    ...golden(),
    "benchmark-pass": goldenScored("benchmark-pass"),
    "benchmark-fail": goldenScored("benchmark-fail"),
    "benchmark-incomplete": goldenScored("benchmark-incomplete"),
  };
}

describe("golden report folders", () => {
  for (const [name, set] of Object.entries(goldenSets())) {
    test(name, () => {
      const tmp = mkdtempSync(join(tmpdir(), "golden-"));
      try {
        const got = join(tmp, "run");
        write(got, set, { json: true, markdown: true });
        const want = join(goldenRoot, name);
        if (update) {
          rmSync(want, { recursive: true, force: true });
          for (const rel of files(got)) {
            const dst = join(want, ...rel.split("/"));
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, readFileSync(join(got, ...rel.split("/"))), {
              mode: 0o644,
            });
          }
        }
        const have = files(got);
        assert.deepEqual(
          have,
          files(want),
          "files differ from the golden folder (UPDATE_GOLDEN=1 regenerates it)",
        );
        for (const rel of have) {
          const a = readFileSync(join(want, ...rel.split("/")));
          const b = readFileSync(join(got, ...rel.split("/")));
          assert.ok(
            a.equals(b),
            `${rel} differs from testdata/golden/${name}/${rel} (UPDATE_GOLDEN=1 regenerates it; review the diff)`,
          );
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
