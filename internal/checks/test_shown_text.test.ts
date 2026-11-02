// Project-controlled names in trusted fields (conventions.md, "Rule:
// project-controlled text in trusted Report fields"): a name or path with
// unusual characters is shown as a placeholder in titles, messages and
// Limitation texts of the test run, and stays in locations and Evidence.
// Plain names read as Go wrote them, which the other tests of this step show.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfidenceSuspected, SeverityWarning } from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { noteServicesNotStarted, shownService } from "./service_not_started.ts";
import { parseTestEvents } from "./test_events.ts";
import { sourceSpecLimitations } from "./test_files_probe.ts";
import {
  endOfSuite,
  findingOf,
  lines,
  nodeNative,
  nodeTestInput,
  results,
  suiteInput,
} from "./test_report.testutil.ts";

const unusual = "(path with unusual characters)";

test("a test file with an unusual name is not written into the title or message", (t) => {
  const input = nodeTestInput(t, { "test/add.test.js": "x" });
  const r = results(
    input,
    nodeNative,
    `{"ev":"file_fail","file":"/work/test/<b>x y.test.js","err":{"name":"Error","message":"x"},"text":"Error: boom"}`,
    endOfSuite,
  );

  const f = findingOf(r, "test-file-load-failed");
  assert.equal(f.title, `A test file fails to load: ${unusual}`);
  assert.ok(f.message.includes(unusual), f.message);
  assert.ok(!f.message.includes("<b>"), f.message);
});

test("a loaded spec file with an unusual name is not written into the Limitation", (t) => {
  const input = suiteInput(t, { "src/a b.spec.js": "x", "src/c.spec.js": "x" });
  const found = (file: string): string =>
    `{"ev":"found","id":1,"file":"${file}","title":"t","fullTitle":"t","suitePath":[]}`;

  const got = sourceSpecLimitations(
    input,
    parseTestEvents(
      lines(found("/work/src/a b.spec.js"), found("/work/src/c.spec.js")),
    ),
  );

  assert.equal(got.length, 1);
  assert.ok(
    got[0]?.message.includes(
      `classified as Source code: ${unusual}, src/c.spec.js.`,
    ),
    got[0]?.message,
  );
});

test("a compose service name with unusual characters is not written into the text", () => {
  assert.equal(shownService("minio"), "minio");
  assert.equal(shownService("my.svc-1_a"), "my.svc-1_a");
  assert.equal(
    shownService("a `b` <c>"),
    "(Service name with unusual characters)",
  );
  const f = newFinding({
    severity: SeverityWarning,
    message: "m.",
    limitations: [],
  });
  noteServicesNotStarted(f, "scripts.test", ["x y"]);
  assert.ok(
    f.message.includes(
      "compose Service (Service name with unusual characters),",
    ),
    f.message,
  );
  assert.equal(f.confidence, ConfidenceSuspected);
});
