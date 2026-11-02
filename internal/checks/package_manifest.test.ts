import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { background } from "../gocompat/context.ts";
import {
  type Finding,
  SeverityError,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { lookup } from "./catalog.ts";
import { implementation, type Result } from "./check.ts";
import { tree, writeTree } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { packageManifest } from "./package_manifest.ts";
import { discover } from "../discovery/discovery.ts";

// package.manifest runs natively, as the engine does: on a Snapshot folder,
// without Docker (Go: package_manifest_test.go).

const lock3 = `{
  "name": "x", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}},
    "node_modules/a": {"version": "1.2.0"},
    "node_modules/b": {"version": "2.1.4", "dev": true}
  }
}`;

const manifestOK = `{"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}}`;

async function runManifest(
  t: TestContext,
  files: Record<string, string>,
  at = ".",
): Promise<Result> {
  const dir = writeTree(t, files);
  const proj = discover(dir);
  const context = proj.contexts.find((c) => c.package?.path === at);
  assert.ok(context !== undefined);
  return packageManifest.run(
    background(),
    new Input({
      project: proj,
      context,
      originalPath: "/original",
      snapshotDir: dir,
    }),
  );
}

function byRule(res: Result): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of res.findings ?? []) {
    const rule = f.rule_id ?? "";
    out.set(rule, [...(out.get(rule) ?? []), f]);
  }
  return out;
}

test("package.manifest is implemented, native and per package", () => {
  // Go: TestPackageManifestIsImplementedNativeAndPerPackage
  const e = lookup("package.manifest");
  assert.equal(e?.status, "implemented");
  assert.equal(e.scope, "package");
  assert.ok(e.canFireGates);
  assert.ok(!("images" in (implementation("package.manifest") ?? {})));
});

test("package.manifest only applies to packages", (t) => {
  // Go: TestPackageManifestOnlyAppliesToPackages
  const proj = tree(t, { "package.json": "{}" });
  const [project, pkg] = proj.contexts;
  assert.ok(project !== undefined && pkg !== undefined);
  assert.equal(
    packageManifest.applicability(proj, project)[0],
    "not_applicable",
  );
  assert.equal(packageManifest.applicability(proj, pkg)[0], "applicable");
});

test("a consistent manifest and lockfile complete without Findings", async (t) => {
  // Go: TestConsistentManifestAndLockfileCompleteWithoutFindings
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "package-lock.json": lock3,
  });
  assert.equal(res.status, StatusCompleted);
  assert.deepEqual([res.findings, res.limitations ?? []], [[], []]);
  assert.deepEqual(
    res.metrics?.map((m) => [m.name, m.reason, m.value, m.unit]),
    [["package_manager", "npm (found by package-lock.json)", null, "name"]],
  );
});

test("a broken package.json is a Gate with its position", async (t) => {
  // Go: TestBrokenPackageJsonIsAGateWithItsPosition
  const res = await runManifest(t, {
    "package.json": '{\n  "name": "x",\n  "version": \n}\n',
    "package-lock.json": lock3,
  });
  const got = byRule(res).get("manifest-invalid");
  assert.equal(got?.length, 1);
  const f = got[0];
  assert.ok(f?.gate);
  assert.equal(f.severity, SeverityError);
  assert.equal(f.locations[0]?.path, "package.json");
  assert.equal(f.locations[0].start?.line, 4);
  assert.notEqual(f.locations[0].file_sha256, "");
  assert.equal(res.status, StatusCompleted, "the lockfile was still checked");
});

test("a broken lockfile is a Gate", async (t) => {
  // Go: TestBrokenLockfileIsAGate
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "package-lock.json": '{"lockfileVersion": 3,',
  });
  const got = byRule(res).get("lockfile-invalid");
  assert.equal(got?.length, 1);
  assert.ok(got[0]?.gate);
  assert.equal(got[0].locations[0]?.path, "package-lock.json");
});

test("a dependency missing from the lockfile is a Gate naming it", async (t) => {
  // Go: TestADependencyMissingFromTheLockfileIsAGateNamingIt
  const res = await runManifest(t, {
    "package.json": `{"dependencies": {"a": "^1.0.0", "z": "^9.0.0"}, "devDependencies": {"b": "~2.1.0"}}`,
    "package-lock.json": lock3,
  });
  const got = byRule(res).get("lockfile-missing-dependency");
  assert.equal(got?.length, 1);
  const f = got[0];
  assert.ok(f?.gate);
  assert.equal(f.expected, "^9.0.0");
  assert.equal(f.actual, "not in package-lock.json");
  assert.equal(f.locations[0]?.path, "package.json");
  assert.deepEqual(f.reproduction.verified_by, ["package.manifest"]);
  assert.deepEqual(f.reproduction.rerun_command, [
    "js-prueffactory",
    "test",
    "/original",
    "--only",
    "package.manifest",
  ]);
});

test("a specifier that does not match the lockfile is a Gate", async (t) => {
  // Go: TestASpecifierThatDoesNotMatchTheLockfileIsAGate
  const res = await runManifest(t, {
    "package.json": `{"dependencies": {"a": "^2.0.0"}, "devDependencies": {"b": "~2.1.0"}}`,
    "package-lock.json": lock3,
  });
  const got = byRule(res).get("lockfile-specifier-mismatch");
  assert.equal(got?.length, 1);
  assert.ok(got[0]?.gate);
  assert.deepEqual([got[0].expected, got[0].actual], ["^2.0.0", "^1.0.0"]);
});

test("a missing lockfile is a warning, not a Gate", async (t) => {
  // Go: TestAMissingLockfileIsAWarningNotAGate
  const res = await runManifest(t, { "package.json": manifestOK });
  const got = byRule(res).get("lockfile-missing");
  assert.equal(got?.length, 1);
  assert.ok(got[0]?.gate === false);
  assert.equal(got[0].severity, SeverityWarning);
  assert.equal(res.status, StatusCompleted);
});

test("lockfiles of several managers are a warning", async (t) => {
  // Go: TestLockfilesOfSeveralManagersAreAWarning
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "package-lock.json": lock3,
    "yarn.lock": "# yarn lockfile v1\n",
  });
  const got = byRule(res).get("lockfile-multiple-managers");
  assert.equal(got?.length, 1);
  assert.ok(got[0]?.gate === false);
  assert.equal(got[0].severity, SeverityWarning);
  assert.deepEqual(
    got[0].locations.map((l) => [l.role, l.path]),
    [
      ["primary", "package-lock.json"],
      ["related", "yarn.lock"],
    ],
  );
});

test("two npm lockfiles are not several managers", async (t) => {
  // Go: TestTwoNpmLockfilesAreNotSeveralManagers
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "package-lock.json": lock3,
    "npm-shrinkwrap.json": lock3,
  });
  assert.deepEqual(res.findings, []);
});

test("a version 1 lockfile makes the lockfile Check unsupported with its reason", async (t) => {
  // Go: TestAVersion1LockfileMakesTheLockfileCheckUnsupportedWithItsReason
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "package-lock.json": `{"lockfileVersion": 1, "dependencies": {}}`,
  });
  assert.deepEqual(res.findings, []);
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "lockfile_version_unsupported");
  assert.notEqual(res.reason, "");
  assert.deepEqual(
    res.limitations?.map((l) => [l.reason_code, l.check_id, l.path]),
    [["lockfile_version_unsupported", "package.manifest", "package-lock.json"]],
  );
});

test("a package that uses another manager is parsed but its lockfile is not checked", async (t) => {
  // Go: TestAPackageThatUsesAnotherManagerIsParsedButItsLockfileIsNotChecked
  const res = await runManifest(t, {
    "package.json": manifestOK,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  assert.deepEqual(res.findings, []);
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "package_manager_unsupported");
  assert.equal(res.metrics?.[0]?.reason, "pnpm (found by pnpm-lock.yaml)");
});

test("Findings of a nested package use project-relative paths", async (t) => {
  // Go: TestFindingsOfANestedPackageUseProjectRelativePaths
  const res = await runManifest(
    t,
    {
      "package.json": "{}",
      "package-lock.json": `{"lockfileVersion": 3, "packages": {"": {}}}`,
      "svc/package.json": "{}",
    },
    "svc",
  );
  const got = byRule(res).get("lockfile-missing");
  assert.equal(got?.length, 1);
  assert.equal(got[0]?.locations[0]?.path, "svc/package.json");
});
