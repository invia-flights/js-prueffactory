import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { type ReadOutcome, readRegular } from "./safefile.ts";

const text = (r: ReadOutcome): string | undefined =>
  r.kind === "ok" ? r.data.toString() : undefined;

const base = realpathSync(mkdtempSync(join(tmpdir(), "jspf-safefile-")));
after(() => {
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
function folder(): string {
  const dir = join(base, `t${String(++n)}`);
  mkdirSync(dir);
  return dir;
}

const refuse = { limit: 16, over: "refuse" } as const;

test("a regular file is read", () => {
  const dir = folder();
  writeFileSync(join(dir, "a"), "hello");
  assert.equal(text(readRegular(join(dir, "a"), refuse)), "hello");
});

test("a file of exactly the limit is read, one byte more is too large", () => {
  const dir = folder();
  writeFileSync(join(dir, "ok"), "x".repeat(16));
  writeFileSync(join(dir, "big"), "x".repeat(17));
  assert.equal(readRegular(join(dir, "ok"), refuse).kind, "ok");
  assert.deepEqual(readRegular(join(dir, "big"), refuse), {
    kind: "too_large",
  });
});

test("truncate mode returns the first limit bytes of a larger file", () => {
  const dir = folder();
  writeFileSync(join(dir, "big"), "0123456789".repeat(5));
  const r = readRegular(join(dir, "big"), { limit: 12, over: "truncate" });
  assert.equal(text(r), "012345678901");
});

test("a missing file is a failed lstat with its error", () => {
  const dir = folder();
  const r = readRegular(join(dir, "nope"), refuse);
  assert.ok(r.kind === "failed");
  assert.equal(r.op, "lstat");
  assert.equal((r.error as NodeJS.ErrnoException).code, "ENOENT");
});

test("without a root a symbolic link is not a regular file", () => {
  const dir = folder();
  writeFileSync(join(dir, "a"), "x");
  symlinkSync(join(dir, "a"), join(dir, "link"));
  assert.deepEqual(readRegular(join(dir, "link"), refuse), {
    kind: "not_regular",
  });
});

test("a folder is not a regular file", () => {
  const dir = folder();
  assert.deepEqual(readRegular(dir, refuse), { kind: "not_regular" });
});

test("a named pipe is refused and never blocks", () => {
  const dir = folder();
  const made = spawnSync("mkfifo", [join(dir, "pipe")]);
  assert.equal(made.status, 0);
  assert.deepEqual(readRegular(join(dir, "pipe"), refuse), {
    kind: "not_regular",
  });
  assert.deepEqual(readRegular(join(dir, "pipe"), { ...refuse, root: dir }), {
    kind: "not_regular",
  });
});

test("with a root a symbolic link that stays inside it is followed", () => {
  const dir = folder();
  mkdirSync(join(dir, "shared"));
  writeFileSync(join(dir, "shared", "a.json"), "{}");
  symlinkSync("shared/a.json", join(dir, "file-link"));
  symlinkSync("shared", join(dir, "folder-link"));
  symlinkSync(join(dir, "shared", "a.json"), join(dir, "absolute-link"));
  for (const p of ["file-link", "folder-link/a.json", "absolute-link"]) {
    const r = readRegular(join(dir, p), { ...refuse, root: dir });
    assert.equal(text(r), "{}", p);
  }
});

test("with a root a symbolic link that leaves it is refused", () => {
  const dir = folder();
  const outside = folder();
  writeFileSync(join(outside, "a.json"), "{}");
  mkdirSync(join(dir, "project"));
  const root = join(dir, "project");
  symlinkSync(join(outside, "a.json"), join(root, "file-link"));
  symlinkSync(outside, join(root, "folder-link"));
  symlinkSync(
    "../../" + outside.slice(base.length + 1) + "/a.json",
    join(root, "relative"),
  );
  for (const p of ["file-link", "folder-link/a.json", "relative"]) {
    const r = readRegular(join(root, p), { ...refuse, root });
    assert.equal(r.kind, "outside", p);
  }
});

test("with a root a link to a folder or a dangling link is not read", () => {
  const dir = folder();
  mkdirSync(join(dir, "sub"));
  symlinkSync("sub", join(dir, "to-folder"));
  symlinkSync("nowhere", join(dir, "dangling"));
  assert.deepEqual(
    readRegular(join(dir, "to-folder"), { ...refuse, root: dir }),
    { kind: "not_regular" },
  );
  assert.equal(
    readRegular(join(dir, "dangling"), { ...refuse, root: dir }).kind,
    "failed",
  );
});

test("a size limit applies to the target of a followed link", () => {
  const dir = folder();
  writeFileSync(join(dir, "big"), "x".repeat(40));
  symlinkSync("big", join(dir, "link"));
  assert.deepEqual(readRegular(join(dir, "link"), { ...refuse, root: dir }), {
    kind: "too_large",
  });
});

test("a path as bytes is read as the file system names it", (t) => {
  const dir = folder();
  const name = Buffer.concat([
    Buffer.from(dir + "/"),
    Buffer.from([0xff, 0x41]),
  ]);
  try {
    writeFileSync(name, "bytes");
  } catch {
    t.skip("this file system does not take names that are not UTF-8");
    return;
  }
  const r = readRegular(name, refuse);
  assert.equal(text(r), "bytes");
});
