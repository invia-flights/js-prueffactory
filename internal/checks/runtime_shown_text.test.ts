// Project text in the trusted fields of the Checks of ticket 15 of the port
// (conventions: "project-controlled text in trusted Report fields"). Go wrote
// these names raw; real names read the same, so the Report is the same for
// every ordinary project.
import assert from "node:assert/strict";
import { test } from "node:test";

import { StatusCompleted } from "../resultset/types.ts";
import { warningFindings } from "./runtime_warnings.ts";
import { Shared } from "./shared.ts";
import {
  stubSuites,
  suiteInput,
  twoSuiteInput,
} from "./test_report.testutil.ts";
import { runCheck } from "./tests_flaky.testutil.ts";
import { testsCoverageID } from "./tests_coverage.ts";
import {
  stubCoverageStore,
  summaryTwoFiles,
} from "./tests_coverage.testutil.ts";

test("the dependency of a warning with an unusual name is not named in the message", (t) => {
  const input = suiteInput(t, { "src/index.js": "x" });
  const stderr =
    "(node:7) DeprecationWarning: x\n    at Object.<anonymous> (/work/node_modules/we`ird/index.js:3:15)\n";

  const [fs] = warningFindings(input, stderr);

  assert.equal(fs.length, 1);
  assert.equal(fs[0]?.rule_id, "warning-from-dependency");
  assert.ok(
    fs[0].message.includes(
      "the dependency (package name with unusual characters)",
    ),
    fs[0].message,
  );
  assert.ok(!fs[0].message.includes("`"), fs[0].message);
});

test("the first frame in the project is named in the message only when it looks like a path", (t) => {
  const input = suiteInput(t, { "src/index.js": "x" });
  const stderr =
    "(node:7) Warning: x\n    at f (/work/src/we`ird.js:3:15)\n    at g (/work/src/index.js:1:1)\n";

  const [fs] = warningFindings(input, stderr);

  assert.equal(fs.length, 1);
  assert.ok(
    fs[0]?.message.includes(
      "The first frame in the project is (path with unusual characters).",
    ),
    fs[0]?.message,
  );
  assert.ok(!fs[0]?.message.includes("we`ird"), fs[0]?.message);
});

test("a route folder such as [id] or {slug} is named in the message", (t) => {
  const input = suiteInput(t, { "src/index.js": "x" });
  const first = (path: string): string | undefined => {
    const stderr = `(node:7) Warning: x\n    at f (/work/${path}:3:15)\n`;
    return warningFindings(input, stderr)[0][0]?.message;
  };

  const plain = first("src/app/[id]/{slug}/page.js");
  assert.ok(
    plain?.includes(
      "The first frame in the project is src/app/[id]/{slug}/page.js.",
    ),
    plain,
  );
});

test("a suite that did not run is named in the coverage note only when its name looks like a word", async (t) => {
  const input = twoSuiteInput(t);
  const second = input.context.package?.tests?.suites[1];
  assert.ok(second);
  second.origin = "test:`api`\n## heading";
  input.shared = new Shared();
  stubSuites(t, (_i, ran) =>
    ran === 1
      ? { status: "infrastructure_error", reasonCode: "x", reason: "no" }
      : {
          status: StatusCompleted,
          coverage: {
            unavailable: "",
            unavailableCode: "",
            summary: null,
            perFile: null,
          },
        },
  );
  stubCoverageStore(t, summaryTwoFiles);

  const res = await runCheck(testsCoverageID, input);

  for (const m of res.metrics ?? []) {
    assert.ok(
      m.reason?.includes(
        "(suite name with unusual characters) did not run its tests",
      ),
      String(m.reason),
    );
    assert.ok(!(m.reason ?? "").includes("heading"));
  }
});
