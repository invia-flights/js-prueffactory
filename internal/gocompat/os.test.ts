import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { byteString, fromByteString, readFile } from "./os.ts";

test("readFile errors name the failed call as Go's os.ReadFile does", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gocompat-")));
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

test("byte strings keep every byte and come back as Go prints them", () => {
  assert.equal(byteString("\u00e9"), "\u00c3\u00a9");
  assert.equal(fromByteString(byteString("\u00e9t\u00e9")), "\u00e9t\u00e9");
  assert.equal(fromByteString("a\u00ffb"), "a\ufffdb");
});
