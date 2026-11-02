// A suite whose tests need a compose Service the Run did not start is
// marked, not blamed on the project (Go: service_not_started_test.go): its
// failures are not Gates, they carry a note, the Gaps say why, and the Pass
// rate is not measured (tests.existing is partial). A suite is marked by a
// static reference in env files or Test code, or by a failing test whose
// Evidence shows a lookup or connection error for the Service's name. The Go
// tests of the Checks that read a marked suite's runs (tests.flaky,
// runtime.unhandled-rejections, runtime.warnings) belong to ticket 15.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { ComposeService } from "../discovery/discovery.ts";
import {
  ConfidenceConfirmed,
  ConfidenceSuspected,
  type Finding,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import type { Input, Result } from "./input.ts";
import {
  namesHost,
  noteServicesNotStarted,
  serviceNotStarted,
} from "./service_not_started.ts";
import { Shared } from "./shared.ts";
import {
  endOfSuite,
  foundAdd,
  foundSub,
  limitationsOfCode,
  runTestsExisting,
  mochaNative,
  passedAdd,
  results,
  stubSuite,
  stubSuites,
  suiteInput,
  twoSuiteInput,
} from "./test_report.testutil.ts";

const minioCompose = `services:
  redis:
    image: valkey/valkey:8.1-alpine
  minio:
    image: quay.io/minio/minio:latest
`;

const failedLookup = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"Error","message":"getaddrinfo EAI_AGAIN minio","stack":"Error: getaddrinfo EAI_AGAIN minio\\n    at GetAddrInfoReqWrap.onlookup [as oncomplete] (node:dns:120:26)"}}`;
const failedOther = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"AssertionError","message":"5 !== 6","stack":"AssertionError: 5 !== 6\\n    at Context.<anonymous> (/work/test/add.test.js:9:12)"}}`;

/**
 * serviceInput is a package with a compose file whose minio entry is not
 * started, and the given further files.
 */
function serviceInput(t: TestContext, files: Record<string, string>): Input {
  const input = suiteInput(t, { ...files, "docker-compose.yml": minioCompose });
  input.shared = new Shared();
  return input;
}

/**
 * suiteRunOf is the result a suite run gives for the events: test cases,
 * Findings and counts, as launchSuite builds them.
 */
function suiteRunOf(input: Input, ...events: string[]): Result {
  const r = results(input, mochaNative, ...events);
  return {
    status: StatusCompleted,
    findings: r.findings,
    testCases: r.testCases,
    inventory: {
      tests: [r.inventory],
      test_suites: [],
      test_files: r.files,
      suppressions: [],
      file_hashes: [],
      size: [],
      moved_test_files: [],
    },
  };
}

const minio: ComposeService = {
  name: "minio",
  file: "docker-compose.yml",
  declared: "quay.io/minio/minio",
  family: "",
  notStarted: {
    code: "unknown_image",
    reason: "the image belongs to no known test Service family",
  },
  env: null,
  unresolved: [],
  versionDiffers: false,
};

test("a failure in a suite that refers to a Service that is not started is no Gate", async (t) => {
  const input = serviceInput(t, {
    "test/add.test.js": "x",
    "test/.test.env": "PORT=1\nHOST=http://minio:9000/x\n",
  });
  stubSuite(
    t,
    suiteRunOf(input, foundAdd, foundSub, passedAdd, failedOther, endOfSuite),
  );

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 1);
  const f = res.findings[0];
  assert.equal(f?.gate, false);
  assert.equal(f.confidence, ConfidenceSuspected);
  assert.ok(f.message.includes("minio"));
  assert.ok(f.message.includes("not start"));
  assert.deepEqual(f.limitations, ["service_not_started"]);
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "service_not_started");
  assert.ok(res.reason?.includes("minio"));
  const got = limitationsOfCode(res, "service_not_started");
  assert.equal(got.length, 1);
  const l = got[0];
  assert.equal(l?.path, "test/.test.env");
  assert.equal(l.check_id, "tests.existing");
  for (const want of [
    "minio",
    "line 2",
    "scripts.test",
    "heuristic",
    "only official Docker Hub images are started",
  ]) {
    assert.ok(l.message.includes(want), `${l.message} lacks ${want}`);
  }
});

test("a suite that refers to a Service that is not started is marked even when all its tests pass", async (t) => {
  const input = serviceInput(t, {
    "test/add.test.js": "x",
    "test/.test.env": "HOST=http://minio:9000/x\n",
  });
  stubSuite(t, suiteRunOf(input, foundAdd, passedAdd, endOfSuite));

  const res = await runTestsExisting(input);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "service_not_started");
  assert.equal(limitationsOfCode(res, "service_not_started").length, 1);
});

test("a failed hook of an affected suite is no Gate either", async (t) => {
  const input = serviceInput(t, {
    "test/add.test.js": "x",
    "test/.test.env": "HOST=http://minio:9000/x\n",
  });
  const hook = `{"ev":"hook_fail","title":"\\"before all\\" hook in \\"add\\"","hookType":"before all","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"boom","stack":"Error: boom"}}`;
  stubSuite(t, suiteRunOf(input, foundAdd, hook, endOfSuite));

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.gate, false);
  assert.equal(res.findings[0].confidence, ConfidenceSuspected);
  assert.ok(res.findings[0].message.includes("minio"));
});

test("a package without a reference keeps its Gates", async (t) => {
  const input = serviceInput(t, { "test/add.test.js": "x" });
  stubSuite(
    t,
    suiteRunOf(input, foundAdd, foundSub, passedAdd, failedOther, endOfSuite),
  );

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.gate, true);
  assert.equal(res.findings[0].confidence, ConfidenceConfirmed);
  assert.equal(res.status, StatusCompleted);
  assert.deepEqual(limitationsOfCode(res, "service_not_started"), []);
});

test("a failing test whose Evidence shows a lookup error for the Service marks its suite", async (t) => {
  const input = serviceInput(t, { "test/add.test.js": "x" });
  stubSuite(
    t,
    suiteRunOf(input, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite),
  );

  const res = await runTestsExisting(input);

  const f = res.findings?.[0];
  assert.equal(f?.gate, false);
  assert.equal(f.confidence, ConfidenceSuspected);
  assert.ok(f.message.includes("minio"));
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "service_not_started");
  const got = limitationsOfCode(res, "service_not_started");
  const [l] = got;
  assert.equal(got.length, 1);
  assert.ok(l);
  assert.ok(l.message.includes("EAI_AGAIN"));
  assert.equal(l.path, "package.json", "a runtime mark points at the manifest");
});

test("a lookup error for another host marks nothing", async (t) => {
  const input = serviceInput(t, { "test/add.test.js": "x" });
  const other = failedLookup.replaceAll("minio", "minio.example.com");
  stubSuite(
    t,
    suiteRunOf(input, foundAdd, foundSub, passedAdd, other, endOfSuite),
  );

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.[0]?.gate, true);
  assert.equal(res.status, StatusCompleted);
});

test("a lookup error for a Service the Run started marks nothing", async (t) => {
  const input = serviceInput(t, { "test/add.test.js": "x" });
  const other = failedLookup.replaceAll("minio", "redis");
  stubSuite(
    t,
    suiteRunOf(input, foundAdd, foundSub, passedAdd, other, endOfSuite),
  );

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.[0]?.gate, true);
  assert.equal(res.status, StatusCompleted);
});

test("a runtime mark affects only the suite whose test failed", async (t) => {
  const input = twoSuiteInput(t);
  const pkg = input.context.package;
  assert.ok(pkg);
  pkg.serviceRefs = [];
  input.project.services = [minio];
  stubSuites(t, (i, ran) =>
    ran === 0
      ? suiteRunOf(i, foundAdd, foundSub, passedAdd, failedOther, endOfSuite)
      : suiteRunOf(i, foundAdd, foundSub, passedAdd, failedLookup, endOfSuite),
  );

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 2);
  assert.equal(
    res.findings[0]?.gate,
    true,
    "the unaffected suite keeps its Gate",
  );
  assert.equal(res.findings[1]?.gate, false);
  assert.equal(res.findings[1].confidence, ConfidenceSuspected);
  const got = limitationsOfCode(res, "service_not_started");
  assert.equal(got.length, 1);
  assert.ok(got[0]?.message.includes("test:api"));
  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "service_not_started");
  assert.ok(res.reason?.includes("test:api"));
});

test("a static reference marks every suite of the package with a Limitation each", async (t) => {
  const input = twoSuiteInput(t);
  input.project.services = [minio];
  const pkg = input.context.package;
  assert.ok(pkg);
  pkg.serviceRefs = [{ service: "minio", file: "test/.test.env", line: 3 }];
  stubSuites(t, (i) => suiteRunOf(i, foundAdd, passedAdd, endOfSuite));

  const res = await runTestsExisting(input);

  const got = limitationsOfCode(res, "service_not_started");
  assert.equal(got.length, 2);
  assert.ok(got[0]?.message.includes("test:unit"));
  assert.ok(got[1]?.message.includes("test:api"));
});

test("a load failure with a lookup error in an affected suite is no Gate, but other load failures are", async (t) => {
  const input = serviceInput(t, {
    "test/add.test.js": "x",
    "test/.test.env": "HOST=http://minio:9000/x\n",
  });
  const lookup = `{"ev":"file_fail","file":"/work/test/add.test.js","text":"Error: getaddrinfo ENOTFOUND other-host\\n    at /work/test/add.test.js:1:1"}`;
  const syntax = `{"ev":"file_fail","file":"/work/test/b.test.js","text":"SyntaxError: Unexpected token"}`;
  stubSuite(t, suiteRunOf(input, lookup, syntax, endOfSuite));

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 2);
  for (const f of res.findings) {
    const isLookup = f.title.includes("add.test.js");
    assert.equal(f.gate, !isLookup, `${f.title} gate`);
  }
});

// A setup file that fetches from the Service and throws a plain Error shows
// no lookup code (the project's own error hides it), but the suite refers to
// the Service by name, so the failure is not blamed on the project. A
// defect of the code itself still is a Gate.
test("a load failure without a lookup code in a statically marked suite is no Gate unless it is a code defect", async (t) => {
  const input = serviceInput(t, {
    "test/add.test.js": "x",
    "test/.test.env": "HOST=http://minio:9000/x\n",
  });
  const setup = `{"ev":"file_fail","file":"/work/test/setup.js","text":"Error: The cache fill of the test setup failed:\\nCache update step failed: step=translations\\n    at fillCaches (/work/test/setup.js:68:15)"}`;
  const syntax = `{"ev":"file_fail","file":"/work/test/b.test.js","text":"SyntaxError: Unexpected token"}`;
  const missing = `{"ev":"file_fail","file":"/work/test/c.test.js","text":"Error: Cannot find module './nope'\\nRequire stack:\\n- /work/test/c.test.js"}`;
  stubSuite(t, suiteRunOf(input, setup, syntax, missing, endOfSuite));

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 3);
  for (const f of res.findings) {
    const isSetup = f.title.includes("setup.js");
    assert.equal(f.gate, !isSetup, `${f.title} gate`);
  }
});

test("a load failure without a lookup code in a package without a reference keeps its Gate", async (t) => {
  const input = serviceInput(t, { "test/add.test.js": "x" });
  const setup = `{"ev":"file_fail","file":"/work/test/setup.js","text":"Error: The cache fill of the test setup failed"}`;
  stubSuite(t, suiteRunOf(input, setup, endOfSuite));

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 1);
  assert.equal(res.findings[0]?.gate, true);
});

// --- beyond the Go tests ---

test("the note of a Finding that reads a marked suite is worded for a warning or a note", () => {
  const f = (severity: Finding["severity"]): Finding =>
    newFinding({ severity, message: "m.", limitations: [] });
  const warning = f(SeverityWarning);
  noteServicesNotStarted(warning, "scripts.test", ["minio"]);
  assert.equal(
    warning.message,
    "m. The suite `scripts.test` may need the compose Service minio, which the Run did not start, so this warning may come from that and not from the project.",
  );
  assert.equal(warning.confidence, ConfidenceSuspected);
  assert.deepEqual(warning.limitations, [serviceNotStarted]);
  const note = f(SeverityNote);
  noteServicesNotStarted(note, "s", ["a", "b"]);
  assert.ok(note.message.includes("Service a, b,"));
  assert.ok(note.message.includes("this note may"));
  const untouched = f(SeverityWarning);
  noteServicesNotStarted(untouched, "s", []);
  assert.equal(untouched.message, "m.");
});

test("a host is named only as a whole host name", () => {
  for (const [text, want] of [
    ["getaddrinfo EAI_AGAIN minio", true],
    ["connect ECONNREFUSED minio:9000", true],
    ["http://minio/x", true],
    ["(minio)", true],
    ["at minio. Next", true],
    ["minio.example.com", false],
    ["my-minio", false],
    ["minio2", false],
    ["minio.", true],
    ["minio.x", false],
  ] as const) {
    assert.equal(namesHost(text, "minio"), want, text);
  }
});
