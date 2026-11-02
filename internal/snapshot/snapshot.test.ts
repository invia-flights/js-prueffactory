import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { compareBytewise } from "../goport/bytewise.ts";
import { Algorithm, take } from "./snapshot.ts";
import { exists, takeIn, tempDir, write } from "./snapshot.testutil.ts";
import { readTar } from "./tar.testutil.ts";

// Ports of internal/snapshot/snapshot_test.go.

test("the Snapshot keeps everything except node_modules and .git", (t) => {
  const root = tempDir(t);
  write(root, "package.json", "{}");
  write(root, ".env", "SECRET=1");
  write(root, ".gitignore", ".env\nbuild/\n");
  write(root, "build/out.js", "x"); // ignored by .gitignore, still part of the Snapshot
  write(root, "node_modules/dep/index.js", "x");
  write(root, "sub/node_modules/dep/index.js", "x");
  write(root, "sub/a.js", "x");
  write(root, ".git/HEAD", "ref: refs/heads/main");

  const s = takeIn(t, root);

  for (const rel of [
    "package.json",
    ".env",
    ".gitignore",
    "build/out.js",
    "sub/a.js",
  ]) {
    assert.ok(exists(join(s.dir, rel)), `${rel} missing from the Snapshot`);
  }
  for (const rel of ["node_modules", "sub/node_modules", ".git"]) {
    assert.ok(!exists(join(s.dir, rel)), `${rel} must not be in the Snapshot`);
  }
  assert.equal(s.fileCount, 5);
  assert.equal(s.algorithm, "sorted-path-sha256-v1");
  assert.equal(Algorithm, "sorted-path-sha256-v1");
});

test("the Snapshot keeps the executable bit and nothing else of the mode", (t) => {
  const root = tempDir(t);
  write(root, "run.sh", "#!/bin/sh\n", 0o755);
  write(root, "data.txt", "x", 0o600);

  const s = takeIn(t, root);

  assert.notEqual(
    statSync(join(s.dir, "run.sh")).mode & 0o100,
    0,
    "run.sh lost its executable bit",
  );
  assert.equal(
    statSync(join(s.dir, "data.txt")).mode & 0o111,
    0,
    "data.txt became executable",
  );
});

test("the Snapshot hash follows the documented algorithm", (t) => {
  const root = tempDir(t);
  write(root, "b.txt", "bee");
  write(root, "a/run.sh", "go", 0o755);

  const s = takeIn(t, root);

  // sorted-path-sha256-v1: per entry in byte-sorted path order, hash the
  // path, the entry type, the executable bit and the content SHA-256; then
  // hash the concatenated entry hashes.
  const sha = (b: string | Buffer) => createHash("sha256").update(b).digest();
  const entry = (path: string, typ: string, exec: string, content: string) =>
    sha(`${path}\x00${typ}\x00${exec}\x00${sha(content).toString("hex")}`);
  const want = sha(
    Buffer.concat([
      entry("a/run.sh", "file", "1", "go"),
      entry("b.txt", "file", "0", "bee"),
    ]),
  );
  assert.equal(s.hash, want.toString("hex"));
});

test("the hash ignores timestamps and other permission bits", (t) => {
  const root = tempDir(t);
  write(root, "a.txt", "x");
  const before = takeIn(t, root).hash;

  chmodSync(join(root, "a.txt"), 0o600);
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(root, "a.txt"), old, old);
  assert.equal(takeIn(t, root).hash, before);
});

test("the hash changes with content, names and the executable bit", (t) => {
  const base = () => {
    const root = tempDir(t);
    write(root, "a.txt", "x");
    return root;
  };
  const ref = takeIn(t, base()).hash;
  const cases: Record<string, (root: string) => void> = {
    content: (root) => {
      write(root, "a.txt", "y");
    },
    rename: (root) => {
      renameSync(join(root, "a.txt"), join(root, "b.txt"));
    },
    exec: (root) => {
      chmodSync(join(root, "a.txt"), 0o755);
    },
    added: (root) => {
      write(root, "c.txt", "");
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const root = base();
    mutate(root);
    assert.notEqual(
      takeIn(t, root).hash,
      ref,
      `hash did not change after ${name}`,
    );
  }
});

test("compare finds every changed path of the Original", (t) => {
  const root = tempDir(t);
  write(root, "keep.txt", "k");
  write(root, "edit.txt", "1");
  write(root, "gone.txt", "1");
  const s = takeIn(t, root);

  assert.deepEqual(s.compare(root, {}), []);

  write(root, "edit.txt", "2");
  unlinkSync(join(root, "gone.txt"));
  write(root, "new/file.txt", "n");
  write(root, "node_modules/x/y.js", "ignored");

  assert.deepEqual(s.compare(root, {}), [
    "edit.txt",
    "gone.txt",
    "new/file.txt",
  ]);
});

test("symbolic links inside are kept and outside are left out with a Limitation", (t) => {
  const outside = tempDir(t);
  write(outside, "secret.txt", "do not read");
  const root = tempDir(t);
  write(root, "README.md", "readme");
  write(root, "docs/other.md", "o");
  symlinkSync("../README.md", join(root, "docs", "index.md"));
  symlinkSync(join(root, "README.md"), join(root, "abs-link.md"));
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(
    `../../${basename(outside)}/secret.txt`,
    join(root, "docs", "escape2.txt"),
  );

  const s = takeIn(t, root);

  assert.equal(readlinkSync(join(s.dir, "docs", "index.md")), "../README.md");
  assert.equal(
    readlinkSync(join(s.dir, "abs-link.md")),
    "README.md",
    "an absolute inside link becomes relative",
  );
  for (const rel of ["escape.txt", "docs/escape2.txt"]) {
    assert.ok(
      !exists(join(s.dir, rel)),
      `${rel} points outside the root and must be left out`,
    );
  }
  const limited = s.limitations.map((l) => l.path).filter((p) => p !== "");
  assert.deepEqual(limited.sort(), ["docs/escape2.txt", "escape.txt"]);
});

test("an explicit output folder inside the root is left out and ignored by compare", (t) => {
  const root = tempDir(t);
  write(root, "a.txt", "a");
  const out = join(root, ".output", "js-prueffactory");
  const opts = { excludeAbs: [out] };

  write(root, ".output/js-prueffactory/old.txt", "x");
  const s = takeIn(t, root, opts);
  assert.ok(
    !exists(join(s.dir, ".output", "js-prueffactory")),
    "output folder was copied",
  );
  assert.deepEqual(s.excluded, [
    "node_modules/",
    ".git",
    ".output/js-prueffactory",
  ]);
  write(root, ".output/js-prueffactory/report.json", "{}");
  assert.deepEqual(
    s.compare(root, opts),
    [],
    "writing the Report must not count as a change",
  );
});

test("writeTar streams the copy with root-owned entries", async (t) => {
  const root = tempDir(t);
  write(root, "a/run.sh", "go", 0o755);
  write(root, "b.txt", "bee");
  symlinkSync("b.txt", join(root, "link"));
  const s = takeIn(t, root);

  const chunks: Buffer[] = [];
  await s.writeTar(
    new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  const entries = readTar(Buffer.concat(chunks));
  for (const e of entries) {
    assert.equal(e.uid, 0, `${e.name} uid`);
    assert.equal(e.gid, 0, `${e.name} gid`);
    assert.equal(e.mtime, 0, `${e.name} mtime`);
  }
  const files = entries.filter((e) => e.type === "0");
  assert.deepEqual(
    files.map((e) => [e.name, e.content.toString(), e.mode]),
    [
      ["a/run.sh", "go", 0o755],
      ["b.txt", "bee", 0o644],
    ],
  );
  assert.deepEqual(
    entries
      .filter((e) => e.type !== "0")
      .map((e) => [e.type, e.name, e.linkname, e.mode]),
    [
      ["5", "a/", "", 0o755],
      ["2", "link", "b.txt", 0o777],
    ],
  );
});

test("the tar keeps long and non-ASCII names", (t) => {
  const root = tempDir(t);
  const long =
    "d".repeat(60) + "/" + "e".repeat(60) + "/" + "f".repeat(120) + ".txt";
  write(root, long, "long");
  write(root, "été.txt", "summer");
  symlinkSync(long, join(root, "long-link"));
  symlinkSync("été.txt", join(root, "accent-link"));
  const s = takeIn(t, root);

  const entries = readTar(Buffer.concat([...s.tarChunks()]));
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get(long)?.content.toString(), "long");
  assert.equal(byName.get("été.txt")?.content.toString(), "summer");
  assert.equal(byName.get("accent-link")?.linkname, "été.txt");
  assert.equal(byName.get("long-link")?.linkname, long);
});

test("remove deletes the host-side copy", (t) => {
  const root = tempDir(t);
  write(root, "a.txt", "a");
  const s = takeIn(t, root);
  s.remove();
  assert.ok(!exists(s.dir), "copy still exists");
});

test("take refuses a destination that already holds a file", (t) => {
  const root = tempDir(t);
  write(root, "a.txt", "a");
  const dest = join(tempDir(t), "copy");
  write(dest, "a.txt", "old");
  assert.throws(() => take(root, dest, {}), /a\.txt: file exists/);
  assert.ok(!exists(dest), "a failed Take removes the destination");
});

// What the Go build computed for every test project and for folders built
// from a spec (see recordedFrom).
interface SpecEntry {
  path: string;
  content?: string;
  mode?: number;
  link?: string;
  dir?: boolean;
}
interface Recorded {
  name: string;
  spec?: SpecEntry[];
  hash: string;
  fileCount: number;
  excluded: string[];
  limitations: { code: string; message: string; path: string }[];
}
const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-snapshots.json", import.meta.url), "utf8"),
) as { recordedFrom: string; snapshots: Recorded[] };

function build(t: TestContext, spec: SpecEntry[]): string {
  const root = tempDir(t);
  const outside = tempDir(t);
  for (const e of spec) {
    const p = join(root, e.path);
    if (e.dir) {
      mkdirSync(p, { recursive: true });
    } else if (e.link !== undefined) {
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(
        e.link.replaceAll("@ROOT", root).replaceAll("@OUTSIDE", outside),
        p,
      );
    } else {
      write(root, e.path, e.content ?? "", e.mode ?? 0o644);
    }
  }
  return root;
}

describe("the Snapshot matches the Go build", () => {
  const repo = new URL("../../", import.meta.url);
  const projects = readdirSync(new URL("testdata/projects/", repo), {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory())
    .map((e) => "testdata/projects/" + e.name);
  test("every test project is in the fixture", () => {
    const names = recorded.snapshots.filter((r) => !r.spec).map((r) => r.name);
    assert.deepEqual(
      names.sort(compareBytewise),
      projects.sort(compareBytewise),
    );
  });

  for (const want of recorded.snapshots) {
    test(want.name, (t) => {
      const root = want.spec
        ? build(t, want.spec)
        : realpathSync(new URL(want.name, repo));
      const s = takeIn(t, root);
      assert.equal(s.hash, want.hash);
      assert.equal(s.fileCount, want.fileCount);
      assert.deepEqual(s.excluded, want.excluded);
      assert.deepEqual(
        s.limitations.map((l) => ({
          ...l,
          message: l.message.replaceAll(root, "<root>"),
        })),
        want.limitations,
      );
    });
  }
});
