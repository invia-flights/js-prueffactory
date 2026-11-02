import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { compareBytewise } from "../goport/bytewise.ts";
import * as lockfile from "./lockfile.ts";
import type { Entry } from "./lockfile.ts";
import { docBytes, text, v3Lock } from "./lockfile.testutil.ts";
import type { Repeat } from "./lockfile.testutil.ts";
import { parseManifest } from "./manifest.ts";

// What the Go build made of each document (see recordedFrom): the parsed
// manifest and lockfile, or the error with its position and text.
interface RecordedError {
  kind: "syntax" | "unsupported";
  line?: number;
  column?: number;
  message?: string;
  version?: string;
  error: string;
}
type Pairs = [string, string][];
interface RecordedCase {
  name: string;
  doc?: string;
  b64?: string;
  repeat?: Repeat;
  manifest: {
    error?: RecordedError;
    value?: {
      dependencies: Pairs;
      devDependencies: Pairs;
      optionalDependencies: Pairs;
      packageManager: string;
      hasWorkspaces: boolean;
      workspaces: string[];
    };
  };
  lock: {
    error?: RecordedError;
    value?: { version: number; packages: [string, Record<string, unknown>][] };
  };
}

const recorded = JSON.parse(
  readFileSync(new URL("testdata/go-parse.json", import.meta.url), "utf8"),
) as { recordedFrom: string; cases: RecordedCase[] };

function pairs(m: ReadonlyMap<string, string>): Pairs {
  return [...m].sort(([a], [b]) => compareBytewise(a, b));
}

function errorRecord(err: unknown): RecordedError {
  if (err instanceof lockfile.SyntaxError) {
    return {
      kind: "syntax",
      line: err.line,
      column: err.column,
      message: err.detail,
      error: err.message,
    };
  }
  if (err instanceof lockfile.UnsupportedVersionError) {
    return {
      kind: "unsupported",
      version: err.version.toString(),
      error: err.message,
    };
  }
  throw err;
}

function entryRecord(e: Entry): Record<string, unknown> {
  return {
    name: e.name,
    version: e.version,
    resolved: e.resolved,
    integrity: e.integrity,
    link: e.link,
    inBundle: e.inBundle,
    dev: e.dev,
    optional: e.optional,
    peer: e.peer,
    hasInstallScript: e.hasInstallScript,
    dependencies: pairs(e.dependencies),
    devDependencies: pairs(e.devDependencies),
    optionalDependencies: pairs(e.optionalDependencies),
    peerDependencies: pairs(e.peerDependencies),
    license: e.license(),
  };
}

describe("parsing matches the Go build", () => {
  for (const c of recorded.cases) {
    test(c.name, () => {
      const data = docBytes(c);
      let manifest: RecordedCase["manifest"];
      try {
        const m = parseManifest(data);
        manifest = {
          value: {
            dependencies: pairs(m.dependencies),
            devDependencies: pairs(m.devDependencies),
            optionalDependencies: pairs(m.optionalDependencies),
            packageManager: m.packageManager,
            hasWorkspaces: m.hasWorkspaces,
            workspaces: [...m.workspaces],
          },
        };
      } catch (err) {
        manifest = { error: errorRecord(err) };
      }
      assert.deepEqual(manifest, c.manifest, "manifest");

      let lock: RecordedCase["lock"];
      try {
        const l = lockfile.parseLock(data);
        lock = {
          value: {
            version: l.version,
            packages: [...l.packages]
              .sort(([a], [b]) => compareBytewise(a, b))
              .map(([k, e]) => [k, entryRecord(e)]),
          },
        };
      } catch (err) {
        lock = { error: errorRecord(err) };
      }
      assert.deepEqual(lock, c.lock, "lockfile");
    });
  }
});

// Ports of internal/lockfile/lockfile_test.go.

test("parseManifest reads the dependency sections", () => {
  const m = parseManifest(
    text(`{
		"name": "x",
		"dependencies": {"a": "^1.0.0"},
		"devDependencies": {"b": "~2.1.0"},
		"optionalDependencies": {"c": "3.0.0"},
		"packageManager": "pnpm@9.1.0+sha256.abc",
		"workspaces": ["packages/*"]
	}`),
  );
  assert.equal(m.dependencies.get("a"), "^1.0.0");
  assert.equal(m.devDependencies.get("b"), "~2.1.0");
  assert.equal(m.optionalDependencies.get("c"), "3.0.0");
  assert.equal(m.packageManager, "pnpm@9.1.0+sha256.abc");
  assert.equal(m.hasWorkspaces, true);
});

test("parseManifest tolerates a byte order mark", () => {
  parseManifest(Buffer.from('\xef\xbb\xbf{"name":"x"}', "latin1"));
});

test("a manifest syntax error has a line and column", () => {
  assert.throws(
    () => parseManifest(text('{\n  "name": "x",\n  "version": \n}\n')),
    (err) =>
      err instanceof lockfile.SyntaxError && err.line === 4 && err.column === 1,
  );
});

test("parseManifest rejects wrong shapes", () => {
  for (const doc of [
    "[]",
    "null",
    "",
    '{"dependencies": ["a"]}',
    '{"dependencies": {"a": 1}}',
  ]) {
    assert.throws(() => parseManifest(text(doc)), lockfile.SyntaxError, doc);
  }
});

test("parseLock reads version 3 entries", () => {
  const l = lockfile.parseLock(text(v3Lock));
  assert.equal(l.version, 3);
  assert.equal(l.packages.size, 4);
  const a = l.packages.get("node_modules/a");
  assert.equal(a?.version, "1.2.0");
  assert.equal(a.integrity, "sha512-aaa");
  assert.equal(a.hasInstallScript, true);
  assert.equal(a.license(), "MIT");
  const b = l.packages.get("node_modules/b");
  assert.equal(b?.dev, true);
  assert.equal(b.license(), "(MIT OR Apache-2.0)");
  assert.equal(l.packages.get("node_modules/l")?.link, true);
  assert.equal(l.packages.get("")?.dependencies.get("a"), "^1.0.0");
});

test("parseLock accepts version 2 with its legacy dependencies tree", () => {
  const l = lockfile.parseLock(
    text('{"lockfileVersion": 2, "packages": {"": {}}, "dependencies": {}}'),
  );
  assert.equal(l.version, 2);
});

test("a version 1 lockfile is unsupported, not broken", () => {
  assert.throws(
    () =>
      lockfile.parseLock(
        text(
          '{"lockfileVersion": 1, "dependencies": {"a": {"version": "1.0.0"}}}',
        ),
      ),
    (err) =>
      err instanceof lockfile.UnsupportedVersionError && err.version === 1n,
  );
});

test("parseLock rejects broken documents", () => {
  for (const doc of [
    '{"lockfileVersion": 3,',
    '{"packages": {}}',
    '{"lockfileVersion": 3, "packages": []}',
    "",
    "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n",
    '{"lockfileVersion": "3", "packages": {}}',
  ]) {
    assert.throws(
      () => lockfile.parseLock(text(doc)),
      lockfile.SyntaxError,
      doc,
    );
  }
});

test("a lockfile without packages is an empty lockfile", () => {
  const l = lockfile.parseLock(text('{"lockfileVersion": 3}'));
  assert.equal(l.version, 3);
  assert.equal(l.packages.size, 0);
});

test("version 4 is unsupported with the version in the reason", () => {
  assert.throws(
    () => lockfile.parseLock(text('{"lockfileVersion": 4, "packages": {}}')),
    (err) =>
      err instanceof lockfile.UnsupportedVersionError && err.version === 4n,
  );
});
