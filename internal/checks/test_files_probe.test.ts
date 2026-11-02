import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { discover, type Package } from "../discovery/discovery.ts";
import {
  newSuite,
  RunnerMocha,
  RunnerNodeTest,
  type Suite,
} from "../discovery/testcommand.ts";
import { background } from "../gocompat/context.ts";
import { type Limitation, StatusCompleted } from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { writeTree } from "./checks.testutil.ts";
import { Input, type Result } from "./input.ts";
import { packageInstall } from "./package_install.ts";
import {
  addTestFileProbe,
  nodeTestFilesOf,
  parseMochaProbe,
  probeMarker,
  testFilesNotResolved,
} from "./test_files_probe.ts";

// The probe asks the project's own Mocha which files a suite loads and turns
// the answer into project paths (Go: test_files_probe_test.go). These tests
// hold the reading of the answer and the expansion for node:test suites; the
// probe itself runs in Docker.

/** suiteInput is Go's suiteInput: a project with a Mocha test script by default. */
function suiteInput(t: TestContext, files: Record<string, string>): Input {
  const all = { "package.json": `{"scripts":{"test":"mocha"}}`, ...files };
  const root = writeTree(t, all);
  const proj = discover(root);
  const context = proj.contexts[1];
  assert.ok(context);
  return new Input({
    project: proj,
    context,
    originalPath: "/orig",
    snapshotDir: root,
  });
}

function probePackage(t: TestContext, files: Record<string, string>): Package {
  const pkg = suiteInput(t, files).context.package;
  assert.ok(pkg);
  return pkg;
}

function limitationsOfCode(res: Result, code: string): Limitation[] {
  return (res.limitations ?? []).filter((l) => l.reason_code === code);
}

const enc = (s: string): Buffer => Buffer.from(s);

test("the Mocha probe answer becomes project paths of the loaded files", (t) => {
  const pkg = probePackage(t, { "src/a.spec.js": "x", "src/setup.js": "x" });
  // What a config file prints comes before the marker line.
  const out = enc(
    "config says hello\n\n" +
      probeMarker +
      `{"ok":true,"noFiles":false,` +
      `"spec":["/work/src/a.spec.js","/work/node_modules/x/spec.js","/etc/passwd","/work"],` +
      `"file":["/work/src/first.js"],"require":["/work/src/setup.js","/work/../escape.js"],"import":["/work/src/esm.mjs"]}` +
      "\n",
  );

  const got = parseMochaProbe(out).testFiles(pkg, "test:unit");

  const id = pkg.contextID;
  assert.deepEqual(got, [
    { contextID: id, path: "src/a.spec.js", suite: "test:unit", kind: "spec" },
    { contextID: id, path: "src/first.js", suite: "test:unit", kind: "file" },
    {
      contextID: id,
      path: "src/setup.js",
      suite: "test:unit",
      kind: "require",
    },
    { contextID: id, path: "src/esm.mjs", suite: "test:unit", kind: "import" },
  ]);
});

test("a package below the root gets project paths with its folder", (t) => {
  const proj = suiteInput(t, {
    "package.json": `{}`,
    "svc/package.json": `{}`,
    "svc/src/a.spec.js": "x",
  }).project;
  const pkg = proj.packages.find((p) => p.path === "svc");
  assert.ok(pkg);
  const out = enc(
    probeMarker +
      `{"ok":true,"spec":["/work/svc/src/a.spec.js","/work/other/b.spec.js"],"file":[],"require":[],"import":[]}`,
  );

  const got = parseMochaProbe(out).testFiles(pkg, "scripts.test");

  assert.deepEqual(
    got.map((f) => f.path),
    ["svc/src/a.spec.js"],
    "a file outside the package is not its test code",
  );
});

test("a Mocha probe that could not answer says why", () => {
  const cases: [string, string, string][] = [
    [
      "no loader files",
      probeMarker +
        `{"ok":false,"code":"no_loader","error":"Mocha has no lib/cli/options.js"}`,
      "none of the loader files",
    ],
    [
      "a config that throws",
      probeMarker +
        `{"ok":false,"code":"load_failed","error":"Unable to read/parse .mocharc.js: boom"}`,
      "boom",
    ],
    ["no answer at all", "some output\n", "no answer"],
    ["an answer that is not JSON", probeMarker + "{nope", "not readable"],
  ];
  for (const [name, out, wantErr] of cases) {
    assert.throws(
      () => parseMochaProbe(enc(out)),
      (err: Error) => err.message.includes(wantErr),
      name,
    );
  }
});

test("a node:test suite is expanded from its file arguments or Node's defaults without a container", (t) => {
  const pkg = probePackage(t, {
    "src/a.spec.js": "x",
    "src/b.test.js": "x",
    "src/ab-test.js": "x",
    "src/plain.js": "x",
  });
  const node = (...args: string[]): Suite =>
    newSuite({
      runner: RunnerNodeTest,
      args: ["--test", ...args],
      origin: "test:node",
    });

  const byArgument = nodeTestFilesOf(pkg, node("src/**/*.spec.js"));
  const byDefault = nodeTestFilesOf(pkg, node());

  assert.deepEqual(byArgument, [
    {
      contextID: pkg.contextID,
      path: "src/a.spec.js",
      suite: "test:node",
      kind: "spec",
    },
  ]);
  assert.deepEqual(
    byDefault.map((f) => f.path),
    ["src/ab-test.js", "src/b.test.js"],
    "Node's default patterns",
  );
});

test("a Mocha suite that is not probed because the install had a Gate is named in a Limitation", async (t) => {
  const input = suiteInput(t, { "src/a.spec.js": "x" });
  const res: Result = {
    status: StatusCompleted,
    findings: [newFinding({ gate: true })],
  };

  await addTestFileProbe(input, background(), res);

  const got = limitationsOfCode(res, testFilesNotResolved);
  assert.equal(got.length, 1, JSON.stringify(res.limitations));
  assert.ok(got[0]?.message.includes("`scripts.test` (mocha)"));
  assert.ok(got[0]?.message.includes("install"));
});

test("a Mocha suite of a package that cannot be installed is named in a Limitation", async (t) => {
  const input = suiteInput(t, { "src/a.spec.js": "x" });
  const pkg = input.context.package;
  assert.ok(pkg);
  pkg.installUnsupported = {
    code: "yarn_not_supported",
    reason: "the package uses Yarn",
  };
  const run = packageInstall.run?.bind(packageInstall);
  assert.ok(run);

  const res = await run(background(), input);

  const got = limitationsOfCode(res, testFilesNotResolved);
  assert.equal(got.length, 1, JSON.stringify(res.limitations));
  assert.ok(got[0]?.message.includes("`scripts.test` (mocha)"));
  assert.ok(got[0]?.message.includes("the package uses Yarn"));
});

test("a package without Mocha suites gets no probe Limitation", async (t) => {
  const input = suiteInput(t, {
    "package.json": `{"scripts":{"test":"node --test"}}`,
    "src/a.test.js": "x",
  });
  const pkg = input.context.package;
  assert.ok(pkg);
  pkg.installUnsupported = {
    code: "yarn_not_supported",
    reason: "the package uses Yarn",
  };
  const run = packageInstall.run?.bind(packageInstall);
  assert.ok(run);

  const res = await run(background(), input);

  assert.deepEqual(
    limitationsOfCode(res, testFilesNotResolved),
    [],
    "node:test suites need no probe",
  );
});

test("Mocha suites are never expanded by name", (t) => {
  const pkg = probePackage(t, { "src/ab-test.js": "x", "src/b.test.js": "x" });
  assert.deepEqual(
    nodeTestFilesOf(
      pkg,
      newSuite({ runner: RunnerMocha, origin: "scripts.test" }),
    ),
    [],
  );
});
