import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeRune, fullRune, goString, trimSpaceBytes } from "./utf8.ts";

// Expected values follow Go's unicode/utf8 and bytes documentation.

test("decodeRune reads an invalid or cut sequence as one error byte", () => {
  assert.deepEqual(decodeRune(Buffer.from("\u00e9")), [0xe9, 2]);
  assert.deepEqual(decodeRune(Buffer.from([0xf0, 0x9f, 0x98])), [0xfffd, 1]);
  assert.deepEqual(decodeRune(Buffer.from([0xed, 0xa0, 0x80])), [0xfffd, 1]);
  assert.deepEqual(decodeRune(Buffer.from([0xc0, 0xaf])), [0xfffd, 1]);
  assert.deepEqual(decodeRune(new Uint8Array()), [0xfffd, 0]);
});

test("fullRune counts an invalid sequence as full and a cut one as not", () => {
  assert.equal(fullRune(Buffer.from([0xf0, 0x9f, 0x98])), false);
  assert.equal(fullRune(Buffer.from([0xf0, 0x9f, 0x22])), true);
  assert.equal(fullRune(Buffer.from([0xff])), true);
});

test("goString replaces each invalid byte with U+FFFD", () => {
  assert.equal(
    goString(Buffer.from([0x61, 0xf0, 0x9f, 0x98, 0x62])),
    "a\ufffd\ufffd\ufffdb",
  );
  assert.equal(goString(Buffer.from([0xed, 0xa0, 0x80])), "\ufffd\ufffd\ufffd");
  assert.equal(
    goString(Buffer.from("\ufeffx")),
    "\ufeffx",
    "a leading U+FEFF stays",
  );
});

test("trimSpaceBytes trims Unicode white space and stops at invalid bytes", () => {
  assert.equal(
    Buffer.from(trimSpaceBytes(Buffer.from("\u2028 x \u3000\t"))).toString(),
    "x",
  );
  assert.deepEqual(
    [...trimSpaceBytes(Buffer.from([0x20, 0xff, 0x20]))],
    [0xff],
  );
});
