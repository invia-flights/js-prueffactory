// Seam A for the Checks that read the ESLint run, on the made-up project
// `unparsable-syntax`: Flow and JSX files that the toolset's ESLint cannot
// parse, next to files it can. 0 hits in a file nobody read is not a
// measurement, so the Checks are partial and the Benchmark treats their parts
// as unknown (Go: unparsable_syntax_docker_test.go). The Go test ran the
// default Selection; this one selects the three Checks.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findingsOf,
  lintReport,
  packageExecution,
  partOf,
} from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("checks that could not parse files are partial and their Benchmark parts are unknown", async (t) => {
  const original = copyProject(t, "unparsable-syntax");

  const r = await realRun(t, [
    "benchmark",
    original,
    "--only",
    "lint.correctness,deps.engines,tests.smells",
  ]);

  const s = lintReport(r);
  for (const id of ["lint.correctness", "deps.engines", "tests.smells"]) {
    const exec = packageExecution(r, s, id);
    assert.ok(
      exec.status === "partial" && exec.reason_code === "files_not_parsed",
      `${id} = ${JSON.stringify(exec)}, want partial with files_not_parsed\n${r.stderr}`,
    );
    // Two Source files (flow.js, view.js) and one Test file (flow.test.js) hold
    // syntax ESLint rejects; tests.smells looks at Test code only.
    const want =
      id === "tests.smells"
        ? "could not parse 1 file"
        : "could not parse 3 files";
    assert.ok(
      exec.reason?.includes(want),
      `${id} reason = ${String(exec.reason)}, want it to contain ${want}`,
    );
  }

  // The Finding in the file that parsed is kept.
  assert.deepEqual(
    findingsOf(s, "lint.correctness").map((f) => f.locations[0]?.path),
    ["src/ok.js"],
  );
  for (const l of s.limitations) {
    if (
      l.reason_code === "files_not_parsed" &&
      l.check_id === "lint.correctness"
    ) {
      assert.ok(
        l.message.includes("src/flow.js") &&
          l.message.includes("src/view.js") &&
          l.message.includes("test/flow.test.js"),
        `limitation ${l.message}, want the three files named`,
      );
    }
  }

  for (const id of ["correctness_lint", "node_compatibility", "smells"]) {
    const p = partOf(s, id);
    assert.ok(
      p.state === "unknown" &&
        p.score === null &&
        p.reason === "partial: files_not_parsed",
      `part ${id} = ${JSON.stringify(p)}, want unknown with the reason partial: files_not_parsed`,
    );
  }
  // Unknown parts mean no single score.
  assert.equal(
    s.benchmark.score,
    null,
    "no score while a Tests part is unknown",
  );
  assert.ok(
    s.benchmark.range !== null &&
      s.benchmark.range.low < s.benchmark.range.high,
  );
  assertNothingLeft(r);
});
