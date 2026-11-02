import assert from "node:assert/strict";
import { test } from "node:test";

import { ExitIncomplete, exitCode } from "../resultset/exitcode.ts";
import { scoredProject } from "../resultset/resultsettest/scored.testutil.ts";
import {
  PartUnknown,
  StatusPartial,
  VerdictIncomplete,
} from "../resultset/types.ts";
import {
  inSuite,
  part,
  score,
  suiteFile,
  wantNull,
} from "./benchmark.testutil.ts";

// A suite that may need a compose Service the Run did not start makes
// tests.existing partial with the reason service_not_started. Its failures
// are no Gates, and the Pass rate is not measured: the range covers it, so a
// Service the tool cannot start never lowers a score or fails a Verdict.

// Go: TestAPackageThatMayNeedAServiceThatIsNotStartedHasNoPassRateAndNoVerdictFail.
test("a package that may need a Service that is not started has no pass rate and no Verdict fail", () => {
  const p = scoredProject();
  p.testFiles(
    suiteFile("test:unit", "test/a.test.js", 4, 4),
    suiteFile("test:api", "test/b.test.js", 4, 0),
  );
  p.status("tests.existing", StatusPartial, "service_not_started");
  p.add("tests.existing", "test-failed", false, inSuite("test:api"));

  const s = score(p);
  const b = s.benchmark;

  const got = part(b, "pass_rate");
  assert.equal(got.state, PartUnknown);
  assert.equal(got.reason, "partial: service_not_started");
  wantNull("pass rate score", got.score);
  wantNull("score", b.score);
  assert.deepEqual(b.gate_finding_ids, []);
  assert.equal(b.verdict, VerdictIncomplete);
  assert.equal(exitCode(s), ExitIncomplete);
});
