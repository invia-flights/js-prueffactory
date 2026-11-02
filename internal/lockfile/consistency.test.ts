import assert from "node:assert/strict";
import { test } from "node:test";

import { check, MissingDependency, SpecifierMismatch } from "./consistency.ts";
import { parseLock } from "./lockfile.ts";
import { text, v3Lock } from "./lockfile.testutil.ts";
import { parseManifest } from "./manifest.ts";

// Ports of internal/lockfile/consistency_test.go.

const lock = (doc: string) => parseLock(text(doc));
const manifest = (doc: string) => parseManifest(text(doc));

test("a consistent manifest and lockfile have no mismatches", () => {
  const m = manifest(
    '{"dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}}',
  );
  assert.deepEqual(check(m, lock(v3Lock)), []);
});

test("a dependency that the lockfile lacks is reported", () => {
  const m = manifest(
    '{"dependencies": {"a": "^1.0.0", "z": "^9.0.0"}, "devDependencies": {"b": "~2.1.0"}}',
  );
  assert.deepEqual(check(m, lock(v3Lock)), [
    {
      kind: MissingDependency,
      name: "z",
      section: "dependencies",
      specifier: "^9.0.0",
      lockSpecifier: "",
    },
  ]);
});

test("a specifier that differs from the lockfile root is reported", () => {
  const m = manifest(
    '{"dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "^3.0.0"}}',
  );
  assert.deepEqual(check(m, lock(v3Lock)), [
    {
      kind: SpecifierMismatch,
      name: "b",
      section: "devDependencies",
      specifier: "^3.0.0",
      lockSpecifier: "~2.1.0",
    },
  ]);
});

test("a dependency the root entry declares but no package entry installs is missing", () => {
  const l = lock(
    '{"lockfileVersion": 3, "packages": {"": {"dependencies": {"a": "^1.0.0"}}}}',
  );
  const got = check(manifest('{"dependencies": {"a": "^1.0.0"}}'), l);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.kind, MissingDependency);
  assert.equal(got[0].name, "a");
});

test("a linked dependency counts as present", () => {
  const l = lock(
    '{"lockfileVersion": 3, "packages": {"": {"dependencies": {"l": "file:../l"}}, "node_modules/l": {"resolved": "../l", "link": true}}}',
  );
  assert.deepEqual(
    check(manifest('{"dependencies": {"l": "file:../l"}}'), l),
    [],
  );
});

test("mismatches come in a stable order", () => {
  const l = lock('{"lockfileVersion": 3, "packages": {"": {}}}');
  const m = manifest(
    '{"devDependencies": {"y": "1"}, "dependencies": {"z": "1", "b": "1"}}',
  );
  assert.deepEqual(
    check(m, l).map((mm) => `${mm.section}:${mm.name}`),
    ["dependencies:b", "dependencies:z", "devDependencies:y"],
  );
});

test("dependency names are ordered by bytes, not UTF-16 units", () => {
  const l = lock('{"lockfileVersion": 3, "packages": {"": {}}}');
  const m = manifest('{"dependencies": {"\u{1f600}": "1", "\uff61": "1"}}');
  assert.deepEqual(
    check(m, l).map((mm) => mm.name),
    ["\uff61", "\u{1f600}"],
  );
});
