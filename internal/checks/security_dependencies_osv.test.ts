import assert from "node:assert/strict";
import { test } from "node:test";

import { Entry } from "../lockfile/lockfile.ts";
import { compareVersions, packageName } from "./security_dependencies_osv.ts";

test("compareVersions orders semantic versions", () => {
  // Go: TestCompareVersionsOrdersSemanticVersions (security_dependencies_merge_test.go)
  for (const [a, b, want] of [
    ["1.2.5", "1.2.6", -1],
    ["1.10.0", "1.2.6", 1],
    ["1.2.6", "1.2.6", 0],
    ["2.0.0-rc.1", "2.0.0", -1],
    ["2.0.0-rc.2", "2.0.0-rc.10", -1],
    ["1.0", "1.0.0", 0],
    ["1.0.0+build", "1.0.0", 0],
    ["v1.0.1", "1.0.0", 1],
    // Beyond Go's table: a core part over int64 is no number and counts
    // as 0, and text prerelease parts compare byte-wise.
    ["99999999999999999999.0.0", "1.0.0", -1],
    ["9223372036854775807.0.0", "9223372036854775806.0.0", 1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
    ["1.0.0-1", "1.0.0-alpha", -1],
  ] as const) {
    assert.equal(
      Math.sign(compareVersions(a, b)),
      want,
      `compareVersions(${a}, ${b})`,
    );
  }
});

test("an entry's package name is its name field, or the folder in its key", () => {
  const alias = new Entry();
  alias.name = "real-name";
  assert.equal(packageName("node_modules/aliased", alias), "real-name");
  assert.equal(
    packageName("node_modules/a/node_modules/@s/b", new Entry()),
    "@s/b",
  );
  assert.equal(packageName("packages/linked", new Entry()), "packages/linked");
});
