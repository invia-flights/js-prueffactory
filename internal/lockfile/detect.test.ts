import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Bun, Deno, detect, NPM, PNPM, Yarn } from "./detect.ts";
import type { Manager } from "./detect.ts";
import { Manifest } from "./manifest.ts";

// Ports of internal/lockfile/detect_test.go.

function dirWith(t: TestContext, ...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const n of names) writeFileSync(join(dir, n), "x");
  return dir;
}

function manifest(packageManager = ""): Manifest {
  const m = new Manifest();
  m.packageManager = packageManager;
  return m;
}

test("detect npm from its lockfile", (t) => {
  const d = detect(dirWith(t, "package.json", "package-lock.json"), manifest());
  assert.equal(d.manager, NPM);
  assert.equal(d.source, "lockfile");
  assert.equal(d.npmLockfile, "package-lock.json");
  assert.equal(d.managers().length, 1);
});

test("detect prefers the shrinkwrap like npm does", (t) => {
  const d = detect(
    dirWith(t, "package-lock.json", "npm-shrinkwrap.json"),
    manifest(),
  );
  assert.equal(d.npmLockfile, "npm-shrinkwrap.json");
  assert.equal(d.lockfiles.length, 2);
  assert.equal(d.managers().length, 1, "two npm lockfiles are one manager");
});

test("detect other managers from their lockfiles", (t) => {
  const cases: [string, Manager][] = [
    ["pnpm-lock.yaml", PNPM],
    ["yarn.lock", Yarn],
    ["bun.lock", Bun],
    ["bun.lockb", Bun],
    ["deno.lock", Deno],
  ];
  for (const [file, want] of cases) {
    const d = detect(dirWith(t, file), manifest());
    assert.equal(d.manager, want, file);
    assert.equal(d.npmLockfile, "", file);
  }
});

test("detect from the packageManager field without a lockfile", (t) => {
  const d = detect(
    dirWith(t, "package.json"),
    manifest("yarn@4.1.0+sha224.abc"),
  );
  assert.equal(d.manager, Yarn);
  assert.equal(d.source, "packageManager");
  assert.equal(d.lockfiles.length, 0);
});

test("detect deno from its config", (t) => {
  assert.equal(
    detect(dirWith(t, "package.json", "deno.json"), manifest()).manager,
    Deno,
  );
});

test("detect assumes npm when nothing says otherwise", (t) => {
  const d = detect(dirWith(t, "package.json"), manifest());
  assert.equal(d.manager, NPM);
  assert.equal(d.source, "default");
});

test("several managers follow the packageManager field", (t) => {
  const dir = dirWith(t, "package-lock.json", "yarn.lock");
  const d = detect(dir, manifest("yarn@1.22.0"));
  assert.equal(d.manager, Yarn);
  assert.deepEqual(d.managers(), [NPM, Yarn]);
  assert.equal(detect(dir, manifest()).manager, NPM, "without a hint npm wins");
});

test("a packageManager field outweighs a lone npm lockfile", (t) => {
  let d = detect(dirWith(t, "package-lock.json"), manifest("yarn@4.1.0"));
  assert.equal(d.manager, Yarn);
  assert.equal(d.source, "packageManager");
  assert.equal(d.npmLockfile, "package-lock.json");
  d = detect(dirWith(t, "package-lock.json"), manifest("npm@10.2.0"));
  assert.equal(d.manager, NPM, "a field naming npm changes nothing");
  assert.equal(d.source, "lockfile");
});

test("a lone lockfile of another manager outweighs the packageManager field", (t) => {
  const d = detect(dirWith(t, "yarn.lock"), manifest("npm@10.2.0"));
  assert.equal(d.manager, Yarn);
  assert.equal(d.source, "lockfile");
});

test("detect ignores an unknown packageManager field", (t) => {
  assert.equal(
    detect(dirWith(t, "package-lock.json"), manifest("mystery@1")).manager,
    NPM,
  );
});

test("a folder without a manifest is read like an empty manifest", (t) => {
  assert.equal(detect(dirWith(t, "pnpm-lock.yaml"), null).manager, PNPM);
});
