// What every first run of a suite does for runtime.warnings, whatever the
// Selection (Go: the addWarningsEnv tests of runtime_warnings_check_test.go,
// and its test that tests.existing and runtime.warnings share one run). The
// rest of that file belongs to ticket 15, which ports the Check's own
// reading of the run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { background } from "../gocompat/context.ts";
import { StatusCompleted } from "../resultset/types.ts";
import { catalog } from "./catalog.ts";
import { addWarningsEnv, runtimeWarningsID } from "./runtime_warnings.ts";
import { resolve } from "./selection.ts";
import { Shared } from "./shared.ts";
import { parseTestEvents } from "./test_events.ts";
import {
  finishedSuite,
  foundAdd,
  lines,
  passedAdd,
  runTestsExisting,
  stubSuite,
  suiteInput,
} from "./test_report.testutil.ts";
import { sharedSuite } from "./tests_coverage.ts";

const selectionWithout = (...exclude: string[]) =>
  resolve(catalog(), [], exclude);

test("NODE_OPTIONS get the warning flags after the value from the test command", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  input.selection = selectionWithout("package.manifest");
  const env: Record<string, string> = { NODE_OPTIONS: "--require ./setup.js" };

  const marker = addWarningsEnv(input, env);

  assert.equal(
    env.NODE_OPTIONS,
    "--require ./setup.js --trace-warnings --trace-deprecation --pending-deprecation",
  );
  assert.equal(marker.graceMs, 30_000);
  assert.notEqual(marker.text, "");
  assert.equal(env.JSPF_END_MARKER, marker.text);
});

test("without a project value NODE_OPTIONS are just our flags", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  const env: Record<string, string> = {};
  addWarningsEnv(input, env);
  assert.equal(
    env.NODE_OPTIONS,
    "--trace-warnings --trace-deprecation --pending-deprecation",
  );
});

test("when runtime.warnings is not selected NODE_OPTIONS stay as the project set them, but the process is still watched", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  input.selection = selectionWithout(runtimeWarningsID);
  const env: Record<string, string> = { NODE_OPTIONS: "--require ./setup.js" };

  const marker = addWarningsEnv(input, env);

  assert.equal(env.NODE_OPTIONS, "--require ./setup.js");
  assert.equal(env.JSPF_END_MARKER, marker.text);
});

test("every run gets its own end marker", (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  const a = addWarningsEnv(input, {});
  const b = addWarningsEnv(input, {});
  assert.notEqual(a.text, b.text, "the project could guess it");
});

test("tests.existing and the Checks that read the run share one run of the suite", async (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x", "src/index.js": "x" });
  input.shared = new Shared();
  const counter = stubSuite(
    t,
    finishedSuite(
      input,
      parseTestEvents(lines(foundAdd, passedAdd)),
      "",
      false,
    ),
  );
  const tests = await runTestsExisting(input);
  const shared = await sharedSuite(background(), input);

  assert.equal(counter.calls, 1, "the suite ran once");
  assert.equal(tests.status, StatusCompleted);
  assert.notEqual(tests, shared, "the two Checks must not share one Result");
});
