import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  byteString,
  createTemp,
  fromByteString,
  mkdirAll,
  readFile,
} from "./os.ts";

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

// Expected texts as Go 1.27 printed them for the same calls.
test("mkdirAll creates parents and fails as Go's os.MkdirAll does", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gocompat-")));
  t.after(() => {
    chmodSync(join(dir, "ro"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirAll(join(dir, "a", "b", "c"), 0o755);
  assert.ok(statSync(join(dir, "a", "b", "c")).isDirectory());
  mkdirAll(join(dir, "a", "b"), 0o755); // exists: no error
  writeFileSync(join(dir, "file"), "x");
  for (const target of [join(dir, "file"), join(dir, "file", "run")]) {
    assert.throws(
      () => {
        mkdirAll(target, 0o755);
      },
      { message: `mkdir ${join(dir, "file")}: not a directory` },
    );
  }
  mkdirSync(join(dir, "ro"), 0o555);
  assert.throws(
    () => {
      mkdirAll(join(dir, "ro", "a", "b"), 0o755);
    },
    { message: `mkdir ${join(dir, "ro", "a")}: permission denied` },
  );
});

test("createTemp makes a new file named prefix and digits, mode 0600", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gocompat-")));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  const [fd, name] = createTemp(dir, ".report.json.tmp-");
  closeSync(fd);
  assert.match(name, /\/\.report\.json\.tmp-[0-9]+$/);
  assert.equal(statSync(name).mode & 0o777, 0o600);
  chmodSync(dir, 0o555);
  assert.throws(() => createTemp(dir, ".x.tmp-"), {
    message: new RegExp(`^open ${dir}/\\.x\\.tmp-[0-9]+: permission denied$`),
  });
});
