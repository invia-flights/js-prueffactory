// What c8's JSON summary and per-file JSON become: three percentages per
// package as metrics, and every file as an artifact. A value that cannot be
// measured is null with a reason (Go: tests_coverage_report_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalTwoFiles,
  metricsByName,
  summaryTwoFiles,
} from "./tests_coverage.testutil.ts";
import { interpretCoverage, noteFailures } from "./tests_coverage_report.ts";

const bytes = (s: string): Uint8Array => Buffer.from(s);

test("a coverage summary becomes line, branch and function percentages of the package", () => {
  const cov = interpretCoverage(
    bytes(summaryTwoFiles),
    bytes(finalTwoFiles),
    "/work/pkg",
    "pkg",
  );

  assert.equal(cov.err, "");
  const ms = metricsByName(cov.metrics);
  for (const [name, want] of [
    ["lines", 61.54],
    ["branches", 66.67],
    ["functions", 33.33],
  ] as const) {
    const m = ms.get(name);
    assert.ok(m);
    assert.equal(m.value, want, name);
    assert.equal(m.unit, "percent");
    assert.equal(
      m.reason,
      null,
      `${name} carries a reason without a failing suite`,
    );
  }
  assert.equal(cov.metrics.length, 3);
});

test("coverage of a package without branches is null with a reason and not an invented 100 percent", () => {
  const summary = `{"total": {"lines":{"total":2,"covered":2,"skipped":0,"pct":100},"statements":{"total":2,"covered":2,"skipped":0,"pct":100},"functions":{"total":1,"covered":1,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}
,"/work/src/a.js": {"lines":{"total":2,"covered":2,"skipped":0,"pct":100},"functions":{"total":1,"covered":1,"skipped":0,"pct":100},"statements":{"total":2,"covered":2,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}}`;

  const cov = interpretCoverage(bytes(summary), null, "/work", ".");

  const ms = metricsByName(cov.metrics);
  const b = ms.get("branches");
  assert.ok(b);
  assert.equal(b.value, null);
  assert.ok(b.reason?.includes("no branches"), String(b.reason));
  assert.equal(ms.get("lines")?.value, 100);
  const doc = JSON.parse(cov.filesDocument.toString("utf8")) as {
    files: { branches: { percent: number | null } }[];
  };
  assert.equal(doc.files.length, 1);
  assert.equal(doc.files[0]?.branches.percent, null);
});

test("coverage of a package without any measured file is null with a reason", () => {
  const summary = `{"total": {"lines":{"total":0,"covered":0,"skipped":0,"pct":100},"statements":{"total":0,"covered":0,"skipped":0,"pct":100},"functions":{"total":0,"covered":0,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":100}}}`;

  const cov = interpretCoverage(bytes(summary), null, "/work", ".");

  assert.equal(cov.metrics.length, 3);
  for (const m of cov.metrics) {
    assert.equal(m.value, null, `${m.name}: c8 reports 100 for nothing`);
    assert.ok((m.reason ?? "") !== "", m.name);
  }
});

test("coverage output that is not readable is an error and never a number", () => {
  for (const [name, summary] of [
    ["empty", ""],
    ["not JSON", "{"],
    ["no total", `{"/work/a.js":{}}`],
  ] as const) {
    const cov = interpretCoverage(bytes(summary), null, "/work", ".");
    assert.notEqual(cov.err, "", name);
    assert.equal(cov.metrics.length, 0, name);
  }
});

test("every file is in the artifact with project-relative paths and its untested functions", () => {
  const cov = interpretCoverage(
    bytes(summaryTwoFiles),
    bytes(finalTwoFiles),
    "/work/pkg",
    "pkg",
  );
  const text = cov.filesDocument.toString("utf8");

  assert.ok(!text.includes("/work"), `a container path leaks: ${text}`);
  const doc = JSON.parse(text) as {
    package: string;
    files: {
      path: string;
      lines: { total: number; covered: number; percent: number | null };
      untested_functions: { name: string; line: number }[];
    }[];
  };
  assert.equal(doc.package, "pkg");
  assert.equal(doc.files.length, 2);
  const [a, b] = doc.files;
  assert.ok(a && b);
  assert.deepEqual(
    [a.path, b.path],
    ["pkg/src/index.js", "pkg/src/unloaded.js"],
  );
  assert.deepEqual(a.lines, { total: 11, covered: 8, percent: 72.73 });
  assert.deepEqual(a.untested_functions, [{ name: "subtract", line: 7 }]);
  assert.deepEqual(b.untested_functions, [{ name: "(anonymous_0)", line: 2 }]);
});

test("the artifact is Go's document: sorted keys, two-space indent, a final newline", () => {
  const cov = interpretCoverage(
    bytes(summaryTwoFiles),
    bytes(finalTwoFiles),
    "/work/pkg",
    "pkg",
  );
  const text = cov.filesDocument.toString("utf8");
  assert.ok(text.endsWith("}\n"));
  assert.ok(
    text.startsWith(
      '{\n  "check_id": "tests.coverage",\n  "files": [\n    {\n      "path": "pkg/src/index.js",',
    ),
  );
  assert.ok(
    text.includes(
      '\n  "package": "pkg",\n  "total": {\n    "branches": {\n      "total": 3,',
    ),
  );
});

test("a failing suite makes every metric carry a note", () => {
  const cov = interpretCoverage(
    bytes(summaryTwoFiles),
    null,
    "/work/pkg",
    "pkg",
  );

  noteFailures(cov, "2 tests failed");

  for (const m of cov.metrics) {
    assert.notEqual(m.value, null, m.name);
    assert.ok(
      m.reason?.includes("2 tests failed"),
      `${m.name}: ${String(m.reason)}`,
    );
  }
});

test("a note is added after a reason that is there already", () => {
  const cov = interpretCoverage(
    bytes(summaryTwoFiles),
    null,
    "/work/pkg",
    "pkg",
  );
  const m = cov.metrics[0];
  assert.ok(m);
  m.reason = "first";
  noteFailures(cov, "1 test failed");
  assert.ok(
    m.reason.startsWith(
      "first; 1 test failed, so the coverage is that of a run with failures",
    ),
  );
});
