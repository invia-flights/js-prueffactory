// The project's Mocha and node:test arguments are kept, except the ones that
// would hide results or hide our reporter; each removal is reported as an
// override (Go: tests_existing_args_test.go,
// tests_existing_nodetest_args_test.go). Also the command log names, a load
// failure's Limitation (Go: tests_existing_suite_names_test.go), and the
// note on a missing program (Go: test_missing_program_test.go).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { discover } from "../discovery/discovery.ts";
import type { ContainerResult } from "../docker/driver.ts";
import { AreaTests, lookup, PerPackage } from "./catalog.ts";
import { packageContext } from "./checks.testutil.ts";
import { Input } from "./input.ts";
import { suiteCount, testLogName } from "./test_suites.ts";
import {
  endOfSuite,
  findingOf,
  foundAdd,
  foundSub,
  mochaNative,
  passedAdd,
  results,
  suiteInput,
} from "./test_report.testutil.ts";
import {
  loadFailure,
  mochaBin,
  testsExisting,
  testsExistingID,
  mochaReporterScript,
  planMochaArgs,
  supportedMochaVersion,
} from "./tests_existing.ts";
import {
  nodeTestReporterScript,
  planNodeTestArgs,
} from "./tests_existing_nodetest.ts";

// The in-container helpers ship unchanged: the bytes the TypeScript build
// copies into the containers are the bytes the Go build embedded at the
// freeze commit (238e07f; the blob IDs of internal/checks/js/ are the same).
test("the reporters and the probe are the Go build's embedded copies, byte for byte", () => {
  const sha = (b: Uint8Array): string =>
    createHash("sha256").update(b).digest("hex");
  assert.equal(
    sha(mochaReporterScript),
    "c04808e419e0731fc33033994bff8134a83c25b527a3ba2780299f762badecbe",
  );
  assert.equal(
    sha(nodeTestReporterScript),
    "b6663c7f60c5de66177a1ca6846d9b9e8e3b8ca4a806548f0da7da0f22764417",
  );
  assert.equal(
    sha(readFileSync(new URL("js/mocha-probe.js", import.meta.url))),
    "50f7d7964dcf711f2c2d3082763c4f22add69669866201dd9c3b70703009b19e",
  );
});

test("a Mocha run keeps the project's arguments and adds our reporter and --no-bail", () => {
  const p = planMochaArgs(
    [
      "test/api",
      "--config",
      "test/mocha-opts.js",
      "--exit",
      "--timeout",
      "5000",
    ],
    "/jspf/mocha-reporter.js",
  );
  assert.deepEqual(p.args, [
    "test/api",
    "--config",
    "test/mocha-opts.js",
    "--exit",
    "--timeout",
    "5000",
    "--reporter",
    "/jspf/mocha-reporter.js",
    "--no-bail",
  ]);
  assert.deepEqual(p.overrides, [], "nothing of the project's was replaced");
  // A single test is re-run with the project's options and no test files.
  assert.deepEqual(p.nativeOptions, [
    "--config",
    "test/mocha-opts.js",
    "--exit",
    "--timeout",
    "5000",
  ]);
});

describe("a Mocha run replaces the project's reporter and bail and says so", () => {
  for (const [name, args, want] of [
    [
      "reporter with a value",
      ["--reporter", "spec", "test/"],
      ["--reporter spec"],
    ],
    ["reporter with equals", ["--reporter=dot", "test/"], ["--reporter=dot"]],
    ["short reporter", ["-R", "xunit", "test/"], ["-R xunit"]],
    [
      "reporter options",
      ["--reporter-option", "output=out.xml", "test/"],
      ["--reporter-option output=out.xml"],
    ],
    ["short reporter options", ["-O", "a=b", "test/"], ["-O a=b"]],
    ["bail", ["--bail", "test/"], ["--bail"]],
    ["short bail", ["-b", "test/"], ["-b"]],
    [
      "all of them",
      ["--bail", "-R", "spec", "-O", "a=b", "test/"],
      ["--bail", "-R spec", "-O a=b"],
    ],
  ] as const) {
    test(name, () => {
      const p = planMochaArgs(args, "/r.js");
      assert.deepEqual(p.overrides, want);
      assert.deepEqual(p.args, ["test/", "--reporter", "/r.js", "--no-bail"]);
      assert.deepEqual(p.nativeOptions, []);
    });
  }
});

test("Mocha versions nine to twelve are supported", () => {
  for (const [v, want] of [
    ["8.4.0", false],
    ["9.0.0", true],
    ["9.2.2", true],
    ["10.8.2", true],
    ["11.7.5", true],
    ["12.0.0", true],
    ["12.3.1", true],
    ["13.0.0", false],
    ["10.0.0-beta.1", true],
    ["", false],
    ["latest", false],
  ] as const) {
    assert.equal(supportedMochaVersion(v), want, v);
  }
});

test("Mocha's executable comes from its bin field and never leaves the package folder", () => {
  const raw = (s: string): Buffer => Buffer.from(s);
  assert.equal(mochaBin(raw(`"bin/mocha"`)), "bin/mocha");
  assert.equal(
    mochaBin(raw(`{"mocha":"./bin/mocha.js","_mocha":"x"}`)),
    "bin/mocha.js",
  );
  assert.equal(mochaBin(raw(`{"_mocha":"x"}`)), "bin/mocha.js");
  assert.equal(mochaBin(raw(`"../../evil.js"`)), "bin/mocha.js");
  assert.equal(mochaBin(raw(`"/evil.js"`)), "bin/mocha.js");
  assert.equal(mochaBin(raw(`"./lib/../bin/x.js"`)), "bin/x.js");
  assert.equal(mochaBin(null), "bin/mocha.js");
  assert.equal(mochaBin(raw(`{"mocha":5}`)), "bin/mocha.js");
});

test("a node:test run keeps the project's arguments and adds our reporter through the reporter options", () => {
  const p = planNodeTestArgs(
    ["--import", "./setup.mjs", "--test-concurrency=2", "--test", "test/api"],
    "/jspf/node-test-reporter.js",
  );
  // Node reads its options only up to the first test file; what follows is
  // for the test files, so our reporter goes in front of them.
  assert.deepEqual(p.args, [
    "--import",
    "./setup.mjs",
    "--test-concurrency=2",
    "--test",
    "--test-reporter=/jspf/node-test-reporter.js",
    "--test-reporter-destination=stdout",
    "test/api",
  ]);
  assert.deepEqual(p.overrides, []);
  assert.deepEqual(p.nativeOptions, [
    "--import",
    "./setup.mjs",
    "--test-concurrency=2",
    "--test",
  ]);
});

describe("a node:test run replaces the project's reporters and says so", () => {
  for (const [name, args, want] of [
    [
      "reporter with a value",
      ["--test", "--test-reporter", "spec", "test/"],
      ["--test-reporter spec"],
    ],
    [
      "reporter with equals",
      ["--test", "--test-reporter=dot", "test/"],
      ["--test-reporter=dot"],
    ],
    [
      "destination",
      ["--test", "--test-reporter-destination", "out.xml", "test/"],
      ["--test-reporter-destination out.xml"],
    ],
    [
      "both, twice",
      [
        "--test",
        "--test-reporter=junit",
        "--test-reporter-destination=a.xml",
        "--test-reporter=lcov",
        "--test-reporter-destination=l.info",
        "test/",
      ],
      [
        "--test-reporter=junit",
        "--test-reporter-destination=a.xml",
        "--test-reporter=lcov",
        "--test-reporter-destination=l.info",
      ],
    ],
  ] as const) {
    test(name, () => {
      const p = planNodeTestArgs(args, "/r.js");
      assert.deepEqual(p.overrides, want);
      assert.deepEqual(p.args, [
        "--test",
        "--test-reporter=/r.js",
        "--test-reporter-destination=stdout",
        "test/",
      ]);
      assert.deepEqual(p.nativeOptions, ["--test"]);
    });
  }
});

describe("the node:test reporter goes in front of the files and of the separator", () => {
  for (const [name, args, want] of [
    [
      "no files",
      ["--test"],
      ["--test", "--test-reporter=/r.js", "--test-reporter-destination=stdout"],
    ],
    [
      "a glob",
      ["--test", "test/**/*.test.js"],
      [
        "--test",
        "--test-reporter=/r.js",
        "--test-reporter-destination=stdout",
        "test/**/*.test.js",
      ],
    ],
    [
      "after the separator",
      ["--test", "--", "-odd.test.js"],
      [
        "--test",
        "--test-reporter=/r.js",
        "--test-reporter-destination=stdout",
        "--",
        "-odd.test.js",
      ],
    ],
  ] as const) {
    test(name, () => {
      assert.deepEqual(planNodeTestArgs(args, "/r.js").args, want);
    });
  }
});

test("node:test option values are not taken for test files", () => {
  const p = planNodeTestArgs(
    [
      "--require",
      "./hook.js",
      "-r",
      "dotenv/config",
      "--test",
      "--test-name-pattern",
      "adds",
      "--",
      "test/a.test.js",
      "test/b.test.js",
    ],
    "/r.js",
  );
  // The project's own name patterns are left out of the native command,
  // because the one test's pattern is added to it and patterns add up.
  assert.deepEqual(p.nativeOptions, [
    "--require",
    "./hook.js",
    "-r",
    "dotenv/config",
    "--test",
  ]);
});

const projects = join(import.meta.dirname, "..", "..", "testdata", "projects");

function testdataInput(name: string): Input {
  const dir = join(projects, name);
  const proj = discover(dir);
  return new Input({
    project: proj,
    context: packageContext(proj, "."),
    snapshotDir: dir,
  });
}

// The command logs of a package with several Suites are named by the Suite
// and sort in chain order, so a reader finds a Suite's log without opening
// them. A package with one Suite keeps the plain name.
test("the command logs of several suites are named by suite", () => {
  const chain = testdataInput("npm-run-chain");
  const got: string[] = [];
  for (let i = 0; i < suiteCount(chain.context.package); i++) {
    got.push(testLogName(chain.forSuite(i)));
  }
  assert.deepEqual(got, [
    "test-output-1-test-unit.log",
    "test-output-2-test-api.log",
  ]);
  assert.equal(testLogName(testdataInput("clean-mocha")), "test-output.log");
});

// A package with several Suites can have one that stops before it reports a
// test. The Limitation that says its tests are not counted names that Suite,
// and a package with one Suite needs no name.
test("the Limitation of a load failure names the suite of a package with several", () => {
  const input = testdataInput("npm-run-chain");
  const c: ContainerResult = {
    exitCode: 1,
    oomKilled: false,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("Exception during run: Error: boom\n"),
    stoppedAfterGrace: false,
  };
  const [, lim] = loadFailure(input.forSuite(1), c);
  assert.ok(lim.message.includes("`test:api`"), lim.message);
});

const failedWith = (message: string): string =>
  `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"Error","message":${JSON.stringify(message)},"stack":"Error: x\\n    at Context.<anonymous> (/work/test/add.test.js:9:12)"}}`;

test("a test that fails because a program is missing gets a note naming program and image", (t) => {
  const input = suiteInput(t, {
    "test/add.test.js": "x",
    ".nvmrc": "22",
    Dockerfile: "FROM node:22-alpine\n",
  });
  const f = findingOf(
    results(
      input,
      mochaNative,
      foundAdd,
      foundSub,
      passedAdd,
      failedWith("spawn git ENOENT"),
      endOfSuite,
    ),
    "test-failed",
  );
  for (const want of [
    "`git`",
    "missing from the Node 22 alpine image",
    "may install it",
  ]) {
    assert.ok(f.message.includes(want), `${f.message} misses ${want}`);
  }
});

test("a test that fails for another reason gets no missing-program note", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  for (const msg of [
    "expected 5 to equal 6",
    "ENOENT: no such file or directory, open 'x'",
    "spawn git EACCES",
  ]) {
    const f = findingOf(
      results(
        input,
        mochaNative,
        foundAdd,
        foundSub,
        passedAdd,
        failedWith(msg),
        endOfSuite,
      ),
      "test-failed",
    );
    assert.ok(!f.message.includes("missing from"), `${msg}: ${f.message}`);
  }
});

test("the program name in the note is cleaned because it comes from the project", (t) => {
  const input = suiteInput(t, { "test/add.test.js": "x" });
  const f = findingOf(
    results(
      input,
      mochaNative,
      foundAdd,
      foundSub,
      passedAdd,
      failedWith("spawn `rm -rf` ENOENT"),
      endOfSuite,
    ),
    "test-failed",
  );
  assert.equal(f.message.split("`").length - 1, 2, f.message);
});

test("tests.existing is implemented, per package, can fire Gates and needs the packages' install", (t) => {
  // Go: TestTestsExistingIsImplementedAndNeedsThePackagesInstall
  const e = lookup(testsExistingID);
  assert.ok(e);
  assert.equal(e.status, "implemented");
  assert.equal(e.canFireGates, true);
  assert.equal(e.area, AreaTests);
  assert.equal(e.scope, PerPackage);

  const input = suiteInput(t, { "test/add.test.js": "x" });
  // It runs after package.install, runs a container on the package's Node
  // image and runs in the Working copy.
  assert.deepEqual(testsExisting.prerequisites?.(input.context), [
    "package.install",
  ]);
  assert.equal(testsExisting.images?.(input.context).length, 1);
  assert.equal(testsExisting.usesWorkingCopy?.(), true);
});
