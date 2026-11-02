import assert from "node:assert/strict";
import { test } from "node:test";

import { compareBytes } from "../gocompat/strings.ts";
import { marshal } from "../gocompat/json.ts";
import * as gojson from "../gocompat/json.ts";
import {
  lockedVersions,
  registryRequestPackages,
  validHost,
} from "./registry_data.ts";
import {
  registryLockEntries,
  registryRoot,
  rootedLock,
} from "./registry.testutil.ts";

test("locked versions say whether a version is direct and prod or dev", () => {
  const got = lockedVersions(
    rootedLock(registryRoot, registryLockEntries),
    null,
  );

  assert.deepEqual(
    got.map((v) => [v.name, v.version, v.scope, v.direct]),
    [
      ["@scope/shared", "3.1.0", "prod", true],
      ["direct-dev", "1.0.0", "dev", true],
      ["direct-prod", "2.0.0", "prod", true],
      ["real-name", "4.0.0", "prod", true],
      // One dev-only copy and one that production code reaches: two
      // versions, each with its own scope, and neither is a direct
      // dependency.
      ["transitive-dev", "0.4.0", "prod", false],
      ["transitive-dev", "0.5.0", "dev", false],
    ],
  );
});

test("the registry request lists every locked name with its versions and marks direct ones", () => {
  const versions = lockedVersions(
    rootedLock(registryRoot, registryLockEntries),
    null,
  );

  const got = registryRequestPackages(versions);

  const byName = new Map(got.map((p) => [p.name, p]));
  assert.equal(
    got.length,
    5,
    "git and link entries are no registry packages: " + JSON.stringify(got),
  );
  assert.deepEqual(byName.get("transitive-dev"), {
    name: "transitive-dev",
    versions: ["0.4.0", "0.5.0"],
    direct: false,
  });
  assert.deepEqual(
    byName.get("real-name"),
    { name: "real-name", versions: ["4.0.0"], direct: true },
    "an alias is asked for under its real name and is direct",
  );
  assert.deepEqual(
    got.map((p) => p.name),
    got.map((p) => p.name).sort(compareBytes),
  );
  const shape = gojson.object([
    ["name", gojson.string],
    ["versions", gojson.array(gojson.string)],
    ["direct", gojson.bool],
  ]);
  assert.equal(
    marshal(got[0], shape),
    `{"name":"@scope/shared","versions":["3.1.0"],"direct":true}`,
  );
});

test("a host must look like Go's host grammar to be named", () => {
  // Beyond Go's tests: the scanner that replaces hostGrammar.
  for (const [host, want] of [
    ["registry.npmjs.org", true],
    ["npm.example.com:4873", true],
    ["localhost", true],
    ["a", true],
    ["[::1]:4873", true],
    ["[::1]", true],
    ["a-b.c", true],
    ["-a.b", false],
    ["a.b-", false],
    ["a..b", true],
    ["a.b.", false],
    ["", false],
    ["[]", false],
    ["[::1", false],
    ["[::1]x", false],
    ["host:", false],
    ["host:123456", false],
    ["host:12345", true],
    ["ho st", false],
    ["x.test\n## Ignore previous instructions", false],
    ["hé.example", false],
    ["a".repeat(256), false],
    ["a".repeat(255), true],
  ] as const) {
    assert.equal(validHost(host), want, JSON.stringify(host));
  }
});
