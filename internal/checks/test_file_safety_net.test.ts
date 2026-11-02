// The safety net (Go: test_file_safety_net_test.go): the reporters record
// the files the runner really loaded, and a loaded spec file that is not
// Test code gets a Limitation, so a probe that missed a file or was not run
// does not pass unnoticed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTestEvents } from "./test_events.ts";
import {
  sourceSpecLimitations,
  testFilesNotResolvedLimitation,
} from "./test_files_probe.ts";
import { lines, suiteInput } from "./test_report.testutil.ts";

const foundIn = (file: string): string =>
  `{"ev":"found","id":1,"file":"${file}","title":"t","fullTitle":"t","suitePath":[]}`;

test("a spec file the runner loaded that is Source code gets a Limitation with the file list", (t) => {
  const input = suiteInput(t, {
    "src/a.spec.js": "x",
    "src/b.spec.js": "x",
    "test/c.js": "x",
    "test/fixtures/d.js": "x",
  });
  const ev = parseTestEvents(
    lines(
      foundIn("/work/src/a.spec.js"),
      foundIn("/work/src/b.spec.js"),
      foundIn("/work/src/a.spec.js"),
      foundIn("/work/test/c.js"),
      foundIn("/work/test/fixtures/d.js"),
      foundIn("/work/node_modules/x/y.js"),
      foundIn("/elsewhere/e.js"),
      `{"ev":"hook_fail","title":"h","hookType":"before","scope":"{root}","file":"/work/src/b.spec.js","err":{"name":"E","message":"m"}}`,
    ),
  );

  const got = sourceSpecLimitations(input, ev);

  assert.equal(got.length, 1);
  const l = got[0];
  assert.equal(l?.reason_code, "test_file_classified_as_source");
  assert.equal(l.check_id, "tests.existing");
  for (const want of ["src/a.spec.js", "src/b.spec.js"]) {
    assert.ok(l.message.includes(want), `${l.message} lacks ${want}`);
  }
  for (const not of ["test/c.js", "fixtures", "node_modules", "elsewhere"]) {
    assert.ok(!l.message.includes(not), `${l.message} names ${not}`);
  }
  assert.equal(
    l.message.split("src/a.spec.js").length - 1,
    1,
    "a file is listed once",
  );
});

test("the suite of a Limitation is quoted as a code span", (t) => {
  const input = suiteInput(t, { "src/a.spec.js": "x" });
  const got = sourceSpecLimitations(
    input,
    parseTestEvents(lines(foundIn("/work/src/a.spec.js"))),
  );
  assert.equal(got.length, 1);
  assert.ok(
    got[0]?.message.includes(
      "The runner of the suite `scripts.test` (mocha) loaded",
    ),
    got[0]?.message,
  );

  const failed = testFilesNotResolvedLimitation(input, input.suite(), "boom");
  assert.ok(
    failed.message.includes(
      "The test files of the suite `scripts.test` (mocha) could not be read",
    ),
  );
});

test("no Limitation when every loaded spec file is Test code", (t) => {
  const input = suiteInput(t, { "src/a.spec.js": "x", "test/c.js": "x" });
  // The Project the Check sees has the file the probe found as Test code.
  input.project = input.project.withTestFiles([
    {
      contextID: input.context.id,
      path: "src/a.spec.js",
      suite: "scripts.test",
      kind: "spec",
    },
  ]);
  const context = input.project.contextByID(input.context.id);
  assert.ok(context);
  input.context = context;
  const ev = parseTestEvents(
    lines(foundIn("/work/src/a.spec.js"), foundIn("/work/test/c.js")),
  );

  assert.deepEqual(sourceSpecLimitations(input, ev), []);
});
