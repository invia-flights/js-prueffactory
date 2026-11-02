import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as nodeJoin } from "node:path";
import { test } from "node:test";

import { compareBytewise } from "./bytewise.ts";
import { byteString, fromByteString, GoError, readFile } from "./os.ts";
import { clean, evalSymlinks, match, rel } from "./path.ts";
import { quote, quoteRune } from "./quote.ts";
import { goString, trimSpace } from "./utf8.ts";

// Expected values come from the Go documentation and the Go build.

test("compareBytewise orders by UTF-8 bytes", () => {
  const names = ["\u{1f600}", "｡", "b", "a", "", "ab", "é"];
  assert.deepEqual(names.sort(compareBytewise), [
    "a",
    "ab",
    "b",
    "é",
    "",
    "｡",
    "\u{1f600}",
  ]);
});

test("goString replaces each invalid byte with U+FFFD", () => {
  assert.equal(goString(Buffer.from([0x61, 0xf0, 0x9f, 0x98, 0x62])), "a���b");
  assert.equal(goString(Buffer.from([0xed, 0xa0, 0x80])), "���");
  assert.equal(goString(Buffer.from("﻿x")), "﻿x", "a leading U+FEFF stays");
});

test("trimSpace trims Unicode white space and stops at invalid bytes", () => {
  assert.equal(Buffer.from(trimSpace(Buffer.from("  x 　\t"))).toString(), "x");
  assert.deepEqual([...trimSpace(Buffer.from([0x20, 0xff, 0x20]))], [0xff]);
});

test("quote and quoteRune escape as strconv does", () => {
  assert.equal(quoteRune(0x27), "'\\''");
  assert.equal(quoteRune(0xa0), "'\\u00a0'");
  assert.equal(quoteRune(0x0b), "'\\v'");
  assert.equal(quoteRune(0x1f600), "'\u{1f600}'");
  assert.equal(
    quote(Buffer.from([0x5c, 0xff, 0x22, 0x09])),
    '"\\\\\\xff\\"\\t"',
  );
});

test("clean follows path.Clean", () => {
  const cases: [string, string][] = [
    ["a/c", "a/c"],
    ["a//c", "a/c"],
    ["a/c/.", "a/c"],
    ["a/c/b/..", "a/c"],
    ["/../a/c", "/a/c"],
    ["/../a/b/../././/c", "/a/c"],
    ["", "."],
    ["../../a", "../../a"],
    ["a/../..", ".."],
    ["/", "/"],
    ["a/", "a"],
  ];
  for (const [in_, want] of cases) assert.equal(clean(in_), want, in_);
});

test("rel follows filepath.Rel", () => {
  assert.equal(rel("/a", "/a/b/c"), "b/c");
  assert.equal(rel("/a", "/b/c"), "../b/c");
  assert.equal(rel("/a/b/c", "/a"), "../..");
  assert.equal(rel("/a", "/a"), ".");
  assert.equal(rel("/a", "./b/c"), undefined);
  assert.equal(rel("/a/..b", "/a"), "..");
});

test("match follows path.Match", () => {
  assert.equal(match("abc", "abc"), true);
  assert.equal(match("a*", "ab/c"), false);
  assert.equal(match("a*/b", "abc/b"), true);
  assert.equal(match("a[^a-c]*", "ad"), true);
  assert.equal(match("[\\]a]", "]"), true);
  assert.equal(match("a?b", "aéb"), true);
  assert.equal(match("[", "a"), undefined);
  assert.equal(match("a\\", "a"), undefined);
  assert.equal(match("*x", "xxx"), true);
});

test("evalSymlinks walks links one element at a time", (t) => {
  const dir = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "goport-")));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(nodeJoin(dir, "file"), "x");
  symlinkSync("file", nodeJoin(dir, "link"));
  symlinkSync("loop", nodeJoin(dir, "loop"));
  const b = byteString(dir);
  assert.equal(evalSymlinks(b + "/link"), b + "/file");
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

test("readFile errors name the failed call as Go does", (t) => {
  const dir = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "goport-")));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(() => readFile(dir), {
    message: `read ${dir}: is a directory`,
  });
  assert.throws(() => readFile(dir + "/none"), {
    message: `open ${dir}/none: no such file or directory`,
  });
});
