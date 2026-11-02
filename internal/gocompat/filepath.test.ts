import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evalSymlinks, rel } from "./filepath.ts";
import { byteString, fromByteString, GoError } from "./os.ts";

test("rel is Go's filepath.Rel", () => {
  // The examples of the Go documentation.
  assert.equal(rel("/a", "/a/b/c"), "b/c");
  assert.equal(rel("/a", "/b/c"), "../b/c");
  assert.equal(rel("/a", "./b/c"), undefined);
  assert.equal(rel("/a/b/c", "/a"), "../..");
  assert.equal(rel("/a", "/a"), ".");
  assert.equal(rel("/a/..b", "/a"), "..");
});

test("evalSymlinks walks links one element at a time", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gocompat-")));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "file"), "x");
  symlinkSync("file", join(dir, "link"));
  symlinkSync("loop", join(dir, "loop"));
  const b = byteString(dir);
  assert.equal(evalSymlinks(b + "/link"), b + "/file");
  // The Go build's texts (see the Snapshot fixture).
  assert.throws(() => evalSymlinks(b + "/file/x"), {
    message: "not a directory",
  });
  assert.throws(() => evalSymlinks(b + "/loop"), {
    message: "EvalSymlinks: too many links",
  });
  assert.throws(
    () => evalSymlinks(b + "/missing/x"),
    (err) =>
      err instanceof GoError &&
      err.notExist &&
      fromByteString(err.message) ===
        `lstat ${dir}/missing: no such file or directory`,
  );
});
