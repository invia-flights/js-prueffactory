import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";

import { load } from "./load.ts";
import type { Loaded } from "./load.ts";
import { v3Lock } from "./lockfile.testutil.ts";

function writeFiles(t: TestContext, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

// Ports of internal/lockfile/load_test.go.

test("an npm package with a version 3 lockfile is usable", (t) => {
  const l = load(
    writeFiles(t, {
      "package.json": '{"dependencies": {"a": "^1.0.0"}}',
      "package-lock.json": v3Lock,
    }),
  );
  assert.equal(l.unsupported, null);
  assert.notEqual(l.lock, null);
  assert.notEqual(l.manifest, null);
  assert.equal(l.manifestErr, null);
  assert.equal(l.lockErr, null);
  assert.equal(l.lockfileName, "package-lock.json");
});

test("a version 1 lockfile is unsupported with the reason", (t) => {
  const l = load(
    writeFiles(t, {
      "package.json": "{}",
      "package-lock.json": '{"lockfileVersion": 1}',
    }),
  );
  assert.equal(l.lock, null);
  assert.equal(l.lockErr, null);
  assert.equal(l.unsupported?.code, "lockfile_version_unsupported");
  assert.notEqual(l.unsupported.reason, "");
});

test("a broken lockfile is an error, not unsupported", (t) => {
  const l = load(
    writeFiles(t, {
      "package.json": "{}",
      "package-lock.json": '{"lockfileVersion": 3,',
    }),
  );
  assert.notEqual(l.lockErr, null);
  assert.equal(l.unsupported?.code, "lockfile_invalid");
});

test("without a lockfile there is nothing to read but no error", (t) => {
  const l = load(writeFiles(t, { "package.json": "{}" }));
  assert.equal(l.lock, null);
  assert.equal(l.lockErr, null);
  assert.equal(l.unsupported?.code, "no_lockfile");
});

test("other managers and workspaces are unsupported", (t) => {
  const pnpm = load(
    writeFiles(t, { "package.json": "{}", "pnpm-lock.yaml": "x" }),
  );
  assert.equal(pnpm.unsupported?.code, "package_manager_unsupported");
  const ws = load(
    writeFiles(t, {
      "package.json": '{"workspaces": ["a"]}',
      "package-lock.json": v3Lock,
    }),
  );
  assert.equal(ws.unsupported?.code, "workspaces_unsupported");
});

test("a broken manifest still reads the lockfile", (t) => {
  const l = load(
    writeFiles(t, { "package.json": "{", "package-lock.json": v3Lock }),
  );
  assert.notEqual(l.manifestErr, null);
  assert.equal(l.manifest, null);
  assert.notEqual(l.lock, null);
  assert.equal(l.unsupported, null);
});

// What the Go build's Load made of each folder (see recordedFrom); "<dir>"
// stands for the folder in error texts.
interface RecordedLoad {
  name: string;
  files: Record<string, string>;
  got: Record<string, unknown>;
}
const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-parse.json", import.meta.url), "utf8"),
) as { loads: RecordedLoad[] };

function summary(l: Loaded, dir: string): Record<string, unknown> {
  const strip = (s: string) => s.replaceAll(dir, "<dir>");
  const got: Record<string, unknown> = {
    manager: l.manager,
    source: l.source,
    npmLockfile: l.npmLockfile,
    lockfileName: l.lockfileName,
    hasManifest: l.manifest !== null,
    hasLock: l.lock !== null,
    lockfiles:
      l.lockfiles.length === 0
        ? null
        : l.lockfiles.map((f) => `${f.name}:${f.manager}`),
    managers: l.lockfiles.length === 0 ? null : l.managers(),
  };
  if (l.manifestErr) got.manifestErr = strip(l.manifestErr.message);
  if (l.lockErr) got.lockErr = strip(l.lockErr.message);
  if (l.unsupported) {
    got.unsupported = {
      code: l.unsupported.code,
      reason: strip(l.unsupported.reason),
    };
  }
  return got;
}

describe("load matches the Go build", () => {
  for (const c of recorded.loads) {
    test(c.name, (t) => {
      const dir = writeFiles(t, c.files);
      assert.deepEqual(summary(load(dir), dir), c.got);
    });
  }
});
