import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";

import { readTar } from "../tarwriter/tar.testutil.ts";
import {
  exists,
  limitedPaths,
  takeIn,
  tarOf,
  tempDir,
  write,
} from "./snapshot.testutil.ts";

// Ports of internal/snapshot/edge_test.go.

const isRoot = process.getuid?.() === 0;

test(
  "unreadable files and special files are left out and listed with their paths",
  { skip: isRoot ? "root can read every file" : false },
  (t) => {
    const root = tempDir(t);
    write(root, "ok.js", "ok");
    write(root, "locked.js", "secret");
    write(root, "src/locked-too.js", "secret");
    for (const rel of ["locked.js", "src/locked-too.js"])
      chmodSync(join(root, rel), 0);
    execFileSync("mkfifo", [join(root, "pipe")]);

    const s = takeIn(t, root);

    for (const rel of ["locked.js", "src/locked-too.js", "pipe"]) {
      assert.ok(
        !exists(join(s.dir, rel)),
        `${rel} must be left out of the copy`,
      );
    }
    assert.ok(exists(join(s.dir, "ok.js")), "ok.js is missing");
    assert.deepEqual(
      limitedPaths(s),
      new Map([
        ["locked.js", "unreadable_path"],
        ["pipe", "special_file"],
        ["src/locked-too.js", "unreadable_path"],
      ]),
    );
    // Go's texts: os.Open's error and the type of the special file.
    assert.deepEqual(
      s.limitations.map((l) => l.message),
      [
        `cannot read locked.js: open ${root}/locked.js: permission denied`,
        "pipe is a special file (p---------) and was left out",
        `cannot read src/locked-too.js: open ${root}/src/locked-too.js: permission denied`,
      ],
    );
    assert.equal(s.fileCount, 1, "left-out files do not count");
    // Left-out files do not make the final re-hash differ.
    assert.deepEqual(s.compare(root, {}), []);
  },
);

test(
  "an unreadable folder is left out with its path",
  { skip: isRoot ? "root can read every folder" : false },
  (t) => {
    const root = tempDir(t);
    write(root, "ok.js", "ok");
    write(root, "private/a.js", "a");
    chmodSync(join(root, "private"), 0);
    let s;
    try {
      s = takeIn(t, root);
    } finally {
      // node:test runs after hooks first-in first-out: unlock before the
      // temporary folder is removed.
      chmodSync(join(root, "private"), 0o755);
    }

    assert.equal(limitedPaths(s).get("private"), "unreadable_path");
    assert.deepEqual(
      s.limitations.map((l) => l.message),
      [`cannot read private: open ${root}/private: permission denied`],
    );
  },
);

// The tool resolves symbolic links before it decides what lies inside the
// root: an absolute link written through another name of the root is still
// inside.
test("an absolute link through an alias of the root is kept as a relative link", (t) => {
  const root = tempDir(t);
  write(root, "README.md", "readme");
  write(root, "docs/.keep", "");
  const alias = join(tempDir(t), "alias");
  symlinkSync(root, alias);
  symlinkSync(join(alias, "README.md"), join(root, "docs", "readme-link"));

  const s = takeIn(t, root);

  assert.equal(
    readlinkSync(join(s.dir, "docs", "readme-link")),
    "../README.md",
  );
  assert.deepEqual(s.limitations, []);
});

test("links that leave the root by any route are left out", (t) => {
  const outside = tempDir(t);
  write(outside, "secret.txt", "do not read");
  write(outside, "dir/inner.txt", "x");
  const root = tempDir(t);
  write(root, "a.txt", "a");
  const links: Record<string, string> = {
    "to-dir": outside, // a folder outside
    dangling: join(outside, "missing.txt"), // does not exist, still outside
    "via-inside": "hop", // inside link that itself points outside
    hop: join(outside, "secret.txt"),
    "loop-a": "loop-b", // cannot be resolved
    "loop-b": "loop-a",
    "to-root-dir": "..", // the parent of the root
  };
  for (const [name, target] of Object.entries(links))
    symlinkSync(target, join(root, name));

  const s = takeIn(t, root);

  assert.deepEqual([...limitedPaths(s).keys()].sort(), [
    "dangling",
    "hop",
    "loop-a",
    "loop-b",
    "to-dir",
    "to-root-dir",
    "via-inside",
  ]);
  assert.deepEqual(readdirSync(s.dir), ["a.txt"]);
  for (const l of s.limitations) {
    assert.ok(
      !(l.message.includes("secret") && l.message.includes("do not read")),
      `a limitation leaks file content: ${l.message}`,
    );
  }
});

test("the symlinks test project keeps its inside links and leaves the outside link out", (t) => {
  const root = new URL("../../testdata/projects/symlinks", import.meta.url)
    .pathname;

  const s = takeIn(t, root);

  for (const [rel, want] of [
    ["main-link.js", "src/index.js"],
    ["docs/notes-link.md", "notes.md"],
  ] as const) {
    assert.equal(readlinkSync(join(s.dir, rel)), want, rel);
  }
  assert.ok(
    !exists(join(s.dir, "outside-link.md")),
    "outside-link.md must be left out",
  );
  assert.deepEqual(s.limitations, [
    {
      code: "symlink_outside_root",
      message:
        "symlink outside-link.md points outside the project and was left out",
      path: "outside-link.md",
    },
  ]);
  // package.json, src/index.js, docs/notes.md and the two kept links
  assert.equal(s.fileCount, 5);
});

// A relative link is copied as written. One that only reaches the root again
// through an alias would point somewhere else inside the copy, so it is left
// out.
test("a relative link that reaches the root through an alias is left out", (t) => {
  const parent = tempDir(t);
  const root = join(parent, "project");
  write(root, "README.md", "readme");
  symlinkSync(root, join(parent, "alias"));
  symlinkSync("../alias/README.md", join(root, "link"));

  const s = takeIn(t, root);

  assert.ok(!exists(join(s.dir, "link")));
  assert.equal(limitedPaths(s).get("link"), "symlink_outside_root");
});

// New in the port: Go sorts paths by their bytes. JavaScript's own order
// compares UTF-16 units and puts U+1F600 (a surrogate pair) before U+FF61.
test("paths are ordered by their UTF-8 bytes", (t) => {
  const root = tempDir(t);
  write(root, "\uff61", "halfwidth");
  write(root, "\u{1f600}", "emoji");

  const s = takeIn(t, root);

  const sha = (b: string | Buffer) => createHash("sha256").update(b).digest();
  const entry = (path: string, content: string) =>
    sha(`${path}\x00file\x000\x00${sha(content).toString("hex")}`);
  // UTF-8: EF BD A1 before F0 9F 98 80.
  const want = sha(
    Buffer.concat([entry("\uff61", "halfwidth"), entry("\u{1f600}", "emoji")]),
  );
  assert.equal(s.hash, want.toString("hex"));
});

// Go keeps a file name as bytes; Node's string names would turn an invalid
// byte into U+FFFD and lose the file. Linux allows such names, macOS does
// not.
test(
  "a file name that is not valid UTF-8 keeps its bytes",
  {
    skip:
      process.platform !== "linux"
        ? "the file system needs UTF-8 names"
        : false,
  },
  (t) => {
    const root = tempDir(t);
    const name = Buffer.from([0x61, 0xff, 0x62]);
    writeFileSync(Buffer.concat([Buffer.from(root + "/"), name]), "x");

    const s = takeIn(t, root);

    const sha = (b: string | Buffer) => createHash("sha256").update(b).digest();
    const entry = sha(
      Buffer.concat([
        name,
        Buffer.from(`\x00file\x000\x00${sha("x").toString("hex")}`),
      ]),
    );
    assert.equal(s.hash, sha(entry).toString("hex"));
    assert.equal(s.fileCount, 1);
    assert.deepEqual(s.compare(root, {}), []);
  },
);

// Two names that differ only in bytes that are not valid UTF-8 are two files.
// Written as text, both would become "a\ufffd.js" in the archive and one
// would overwrite the other in the volume, so the Checks would see something
// else than the Snapshot hash covers. Go writes the bytes.
test(
  "names that are not valid UTF-8 reach the archive as their bytes",
  {
    skip:
      process.platform !== "linux"
        ? "the file system needs UTF-8 names"
        : false,
  },
  async (t) => {
    const root = tempDir(t);
    const raw = (s: string) => Buffer.from(s, "latin1");
    const at = (name: Buffer) => Buffer.concat([raw(root + "/"), name]);
    writeFileSync(at(raw("a\xfe.js")), "fe");
    writeFileSync(at(raw("a\xff.js")), "ff");
    symlinkSync(raw("a\xff.js"), at(raw("l\xff")));

    const s = takeIn(t, root);

    assert.deepEqual(
      readTar(await tarOf(s)).map((e) => [
        e.type,
        e.nameBytes.toString("hex"),
        e.linknameBytes.toString("hex"),
        e.content.toString(),
      ]),
      [
        ["0", "61fe2e6a73", "", "fe"],
        ["0", "61ff2e6a73", "", "ff"],
        ["2", "6cff", "61ff2e6a73", ""],
      ],
    );
  },
);
