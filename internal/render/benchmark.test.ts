import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatFloatFixed } from "../gocompat/fmt.ts";
import { goldenScored } from "../resultset/helpers.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import type { Set } from "../resultset/types.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { md, section } from "./render.testutil.ts";

// The Go tests of the Benchmark section built their sets with benchmark.Apply.
// Until the scorer is ported (ticket 06), the three golden benchmark sets
// stand in where a test only needs some scored Report; the tests that need
// the scorer's numbers for a particular project move to ticket 06.

/** benchmarkSection returns the text of the "Benchmark" section of report.md. */
function benchmarkSection(s: Set): string {
  const text = md(s);
  const start = text.indexOf("\n## Benchmark\n");
  assert.ok(start >= 0, "no Benchmark section");
  let rest = text.slice(start + 1);
  const end = rest.slice("## Benchmark\n".length).indexOf("\n## ");
  if (end >= 0) {
    rest = rest.slice(0, "## Benchmark\n".length + end);
  }
  return rest;
}

function lineWith(text: string, needle: string): string {
  return text.split("\n").find((l) => l.includes(needle)) ?? "";
}

// Go: TestTestModeStillSaysNoScoreWasComputed.
test("test mode still says no score was computed", () => {
  const got = benchmarkSection(minimal());
  assert.ok(got.includes("No Benchmark score computed in test mode"), got);
  assert.ok(!got.includes("fingerprint"), got);
});

// Go: TestADroppedPartAndADroppedAreaAreMarked.
test("a dropped part is marked", () => {
  const row = lineWith(
    benchmarkSection(goldenScored("benchmark-pass")),
    "Helm",
  );
  assert.ok(row.includes("not applicable"), row);
});

// Go: TestMarkdownAndJSONAgreeOnTheScoreTheRangeAndTheVerdict.
describe("report.md and report.json agree on score, range and Verdict", () => {
  for (const name of [
    "benchmark-pass",
    "benchmark-fail",
    "benchmark-incomplete",
  ] as const) {
    test(name, () => {
      const s = goldenScored(name);
      const data = json(s);
      assert.deepEqual(validate(data), []);
      const doc = JSON.parse(Buffer.from(data).toString("utf8")) as {
        benchmark: {
          score: number | null;
          verdict: string;
          range: { low: number; high: number };
        };
      };
      const got = benchmarkSection(s);
      const b = doc.benchmark;
      assert.ok(got.includes(`Verdict: **${b.verdict}**`), got);
      if (b.score !== null) {
        assert.ok(got.includes(`${formatFloatFixed(b.score, 1)} of 100`));
      } else {
        assert.ok(
          got.includes(
            `Range: ${formatFloatFixed(b.range.low, 1)} to ${formatFloatFixed(b.range.high, 1)}`,
          ),
          got,
        );
      }
    });
  }
});

// Go: TestBothReportsSayWhetherFastWasUsedAndWhereTheBudgetCameFrom.
test("both reports say whether --fast was used and where the Budget came from", () => {
  for (const fast of [false, true]) {
    const s = goldenScored("benchmark-pass");
    s.selection.fast = fast;
    if (fast) {
      s.run.budget_seconds = 1800;
      s.run.budget_source = "fast_default";
    }
    const doc = JSON.parse(Buffer.from(json(s)).toString("utf8")) as {
      selection: { fast: boolean };
      run: { budget_source: string };
    };
    assert.equal(doc.selection.fast, fast);
    const text = md(s);
    if (fast) {
      assert.ok(text.includes("(fast_default)"));
      assert.equal(doc.run.budget_source, "fast_default");
    }
    assert.ok(text.includes(`- \`--fast\`: ${fast ? "yes" : "no"}`));
  }
});

// Go: TestProjectAndToolTextInTheBenchmarkSectionCannotBreakTheTables.
test("project and tool text in the Benchmark section cannot break the tables", () => {
  const s = goldenScored("benchmark-pass");
  const hostile = "x|y <script>alert(1)</script>\n# not a heading";
  const part = s.benchmark.areas[0]?.parts[0];
  const indicator = s.benchmark.side_indicators[0];
  assert.ok(part && indicator);
  part.reason = hostile;
  indicator.reason = hostile;
  const got = benchmarkSection(s);
  assert.ok(!got.includes("<script>"), got);
  assert.ok(!got.includes("\n# not a heading"), got);
});

// Go: TestAReportInBenchmarkModeNamesTheCommandAndKeepsEverythingElse.
test("a benchmark mode Report names the command and keeps every section", () => {
  const text = md(goldenScored("benchmark-pass"));
  assert.ok(text.includes("- Command: `benchmark`"));
  for (const h of ["## Gaps", "## Summary", "## Gates", "## Inventory"]) {
    assert.ok(text.includes(h), h);
  }
  assert.notEqual(section(text, "## Benchmark"), "");
});
