// The pinned tool table, the shipped manifest and the shipped lockfile are
// three views of one fact. These tests read the files as an npm user would
// and compare them with the table.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./all.ts";
import {
  npmLockfileBytes,
  npmManifestBytes,
  npmTool,
  npmToolList,
} from "./npmtools.ts";

interface Manifest {
  dependencies: Record<string, string>;
}

interface Lock {
  lockfileVersion: number;
  packages: Record<
    string,
    { version?: string; integrity?: string; license?: string }
  >;
}

const decode = (b: Uint8Array): unknown =>
  JSON.parse(Buffer.from(b).toString("utf8"));

test("every npm tool is pinned in the manifest and the lockfile", () => {
  const tools = npmToolList();
  assert.ok(tools.length > 0, "the table lists no npm tool");
  const manifest = decode(npmManifestBytes()) as Manifest;
  const lock = decode(npmLockfileBytes()) as Lock;
  assert.ok(lock.lockfileVersion >= 2, String(lock.lockfileVersion));

  for (const tool of tools) {
    assert.ok(tool.name !== "" && tool.version !== "" && tool.license !== "");
    let got = manifest.dependencies[tool.package] ?? "";
    // An npm alias such as "npm:typescript@7.0.2" pins as exactly as a
    // version does.
    if (got.startsWith("npm:")) {
      got = got.slice(got.lastIndexOf("@") + 1);
    }
    assert.equal(got, tool.version, `${tool.package}: manifest pin`);
    const locked = lock.packages["node_modules/" + tool.package];
    assert.ok(locked, `${tool.package} is missing from the lockfile`);
    assert.equal(locked.version, tool.version, tool.package);
    assert.ok(locked.integrity?.startsWith("sha512-"), tool.package);
    assert.equal(locked.license, tool.license, tool.package);
    assert.equal(tool.integrity, locked.integrity, tool.package);
  }
});

test("the npm tools of the table", () => {
  const want: [string, string, string, string][] = [
    ["eslint-plugin-mocha", "12.0.2", "MIT", "eslint-plugin-mocha"],
    ["eslint-plugin-n", "18.5.0", "MIT", "eslint-plugin-n"],
    [
      "eslint-plugin-sonarjs",
      "4.2.2",
      "LGPL-3.0-only",
      "eslint-plugin-sonarjs",
    ],
    ["jscpd", "5.4.2", "MIT", "jscpd"],
    // The alias package is Microsoft's compatibility package: it exposes the
    // TypeScript 6 compiler API and the tsc6 binary next to TypeScript 7.
    ["typescript6", "6.0.2", "Apache-2.0", "@typescript/typescript6"],
    ["type-coverage", "2.30.4", "MIT", "type-coverage"],
    ["typescript-eslint", "8.72.0", "MIT", "typescript-eslint"],
    ["c8", "12.0.0", "ISC", "c8"],
  ];
  for (const [name, version, license, pkg] of want) {
    const tool = npmTool(name);
    assert.ok(tool, `${name} is not in the table`);
    assert.equal(tool.version, version, name);
    assert.equal(tool.license, license, name);
    assert.equal(tool.package, pkg, name);
    assert.equal(tool.runInstallScripts, false, name);
  }
});
