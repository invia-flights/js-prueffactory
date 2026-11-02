import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as nodeJoin } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  abs,
  evalSymlinks,
  evalSymlinksText,
  readDirNames,
  rel,
  stat,
} from "./filepath.ts";
import { byteString, fromByteString, GoError, isNotExist } from "./os.ts";
import { base, dir, join } from "./path.ts";

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
  const dir = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "gocompat-")));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(nodeJoin(dir, "file"), "x");
  symlinkSync("file", nodeJoin(dir, "link"));
  symlinkSync("loop", nodeJoin(dir, "loop"));
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

test("evalSymlinksText takes and gives text, also for names beyond ASCII", (t) => {
  const root = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "gocompat-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(nodeJoin(root, "déjà"));
  symlinkSync("déjà", nodeJoin(root, "日本"));
  assert.equal(evalSymlinksText(`${root}/日本`), `${root}/déjà`);
  assert.throws(
    () => evalSymlinksText(`${root}/ü/x`),
    (err) =>
      err instanceof GoError &&
      err.notExist &&
      err.message === `lstat ${root}/ü: no such file or directory`,
  );
});

// What Go returns on the same tree (see recordedFrom and the generator).
const oracle = JSON.parse(
  readFileSync(
    new URL("testdata/go-oracle-filepath.json", import.meta.url),
    "utf8",
  ),
) as {
  evalSymlinks: { In: string; Out: string; Err: string }[];
  stat: { In: string; IsDir: string; StatErr: string; ReadDirErr: string }[];
  paths: { In: string; Dir: string; Base: string }[];
  joins: { In: string[]; Out: string }[];
};

const asRoot = process.getuid?.() === 0;

describe("on the oracle's tree", () => {
  let root = "";
  const hide = (s: string) => s.replaceAll(root, "<root>");
  const errText = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return hide((err as Error).message);
    }
    return "";
  };

  before(() => {
    root = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "filepath-")));
    mkdirSync(nodeJoin(root, "dir", "sub"), { recursive: true });
    writeFileSync(nodeJoin(root, "file"), "x");
    symlinkSync(nodeJoin(root, "dir"), nodeJoin(root, "link-dir"));
    symlinkSync("file", nodeJoin(root, "link-file"));
    symlinkSync("../dir", nodeJoin(root, "dir", "link-up"));
    symlinkSync("nope", nodeJoin(root, "dangling"));
    symlinkSync("loop-b", nodeJoin(root, "loop-a"));
    symlinkSync("loop-a", nodeJoin(root, "loop-b"));
    symlinkSync("/", nodeJoin(root, "link-root"));
    mkdirSync(nodeJoin(root, "noperm", "inner"), { recursive: true });
    chmodSync(nodeJoin(root, "noperm"), 0o000);
  });
  after(() => {
    chmodSync(nodeJoin(root, "noperm"), 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  for (const c of oracle.evalSymlinks) {
    const permission = c.Err.includes("permission denied");
    test(`EvalSymlinks <root>/${c.In}`, { skip: permission && asRoot }, () => {
      let out = "";
      const err = errText(() => (out = evalSymlinksText(`${root}/${c.In}`)));
      assert.equal(err, c.Err);
      assert.equal(hide(out), c.Out);
    });
  }

  for (const c of oracle.stat) {
    const permission = (c.StatErr + c.ReadDirErr).includes("permission denied");
    test(
      `Stat and ReadDir <root>/${c.In}`,
      { skip: permission && asRoot },
      () => {
        const p = join(root, c.In);
        const seen = { isDir: false };
        assert.equal(
          errText(() => (seen.isDir = stat(p).isDirectory())),
          c.StatErr,
        );
        assert.equal(seen.isDir ? "yes" : "", c.IsDir);
        assert.equal(
          errText(() => readDirNames(p)),
          c.ReadDirErr,
        );
      },
    );
  }

  test("isNotExist is true only for a missing file", () => {
    const missing = (p: string) => {
      try {
        stat(join(root, p));
      } catch (err) {
        return isNotExist(err);
      }
      return false;
    };
    assert.equal(missing("nope"), true);
    assert.equal(missing("dangling"), true);
    assert.equal(missing("file/x"), false); // ENOTDIR is not fs.ErrNotExist
  });

  test("ReadDir lists names in byte order", () => {
    assert.deepEqual(readDirNames(join(root, "dir")), ["link-up", "sub"]);
  });
});

describe("Dir and Base", () => {
  for (const c of oracle.paths) {
    test(JSON.stringify(c.In), () => {
      assert.equal(dir(c.In), c.Dir);
      assert.equal(base(c.In), c.Base);
    });
  }
});

describe("Join", () => {
  for (const c of oracle.joins) {
    test(JSON.stringify(c.In), () => {
      assert.equal(join(...c.In), c.Out);
    });
  }
});

describe("Abs", () => {
  test("an absolute path is only cleaned", () => {
    assert.equal(abs("/a/./b/../c/"), "/a/c");
  });

  test("a relative path is joined to the working folder, through $PWD as Go's Getwd", () => {
    // Go's os.Getwd returns $PWD when it names the working folder, so a
    // folder reached through a symlink keeps the symlink's name.
    const real = realpathSync(mkdtempSync(nodeJoin(tmpdir(), "abs-")));
    const link = `${real}-link`;
    symlinkSync(real, link);
    const cwd = process.cwd();
    const pwd = process.env.PWD;
    try {
      process.chdir(link);
      process.env.PWD = link;
      assert.equal(abs("x/../y"), `${link}/y`);
      process.env.PWD = "/somewhere/else";
      assert.equal(abs("y"), `${real}/y`);
      process.env.PWD = "relative";
      assert.equal(abs("y"), `${real}/y`);
    } finally {
      process.chdir(cwd);
      if (pwd === undefined) {
        delete process.env.PWD;
      } else {
        process.env.PWD = pwd;
      }
      rmSync(link);
      rmSync(real, { recursive: true });
    }
  });
});
