import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { apply } from "../benchmark/score.ts";
import { formatFloatFixed } from "../gocompat/fmt.ts";
import { goldenScored } from "../resultset/helpers.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import {
  evidence,
  type Project,
  scoredProject,
} from "../resultset/resultsettest/scored.testutil.ts";
import {
  type Set,
  StatusInfrastructureError,
  StatusPartial,
  StatusUnsupported,
} from "../resultset/types.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import { gaps, md, section } from "./render.testutil.ts";

/** benchmarkSet scores the clean project after mutate changed it. */
function benchmarkSet(mutate: ((p: Project) => void) | null): Set {
  const p = scoredProject();
  mutate?.(p);
  const s = p.done();
  apply(s);
  assert.deepEqual(validateRules(s), [], "fixture is inconsistent");
  return s;
}

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
  const variants: Record<string, () => Set> = {
    pass: () => benchmarkSet(null),
    fail: () =>
      benchmarkSet((p) => {
        p.add("syntax.parse", "SyntaxError", true);
      }),
    incomplete: () =>
      benchmarkSet((p) => {
        p.status(
          "security.dependencies",
          StatusInfrastructureError,
          "advisory_database_unavailable",
        );
      }),
    "golden benchmark-pass": () => goldenScored("benchmark-pass"),
    "golden benchmark-fail": () => goldenScored("benchmark-fail"),
    "golden benchmark-incomplete": () => goldenScored("benchmark-incomplete"),
  };
  for (const [name, build] of Object.entries(variants)) {
    test(name, () => {
      const s = build();
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

function assertIncludesAll(text: string, wants: readonly string[]): void {
  for (const want of wants) {
    assert.ok(
      text.includes(want),
      `the Benchmark section lacks ${JSON.stringify(want)}:\n${text}`,
    );
  }
}

// Go: TestTheMarkdownShowsScoreVerdictAreasPartsAndFingerprint.
test("the Markdown shows score, Verdict, areas, parts and fingerprint", () => {
  const s = benchmarkSet((p) => {
    p.add(
      "security.dependencies",
      "GHSA-mod",
      false,
      evidence("advisory_severity", "moderate"),
      evidence("dependency_scope", "prod"),
    );
    for (let i = 0; i < 4; i++) {
      p.add("lint.correctness", "no-undef", false);
    }
  });
  const got = benchmarkSection(s);
  assert.ok(s.benchmark.fingerprint);
  assertIncludesAll(got, [
    "benchmark-v2-uncalibrated",
    "uncalibrated",
    "**Score: 93.9 of 100**",
    "Verdict: **pass**",
    "| Tests | 40 |",
    "| Validity | 20 |",
    "| Security | 25 |",
    "| Code correctness | 15 |",
    "Correctness lint",
    "Vulnerabilities",
    "Gates: none",
    "Side indicators",
    "weight 0",
    s.benchmark.fingerprint.hash,
    "comparable only between Runs with equal fingerprints",
  ]);
  // A part row shows raw value, n_eff, x50 and score: four hits of one rule
  // are n_eff 3 and, at x50 = 10, 81.2.
  const row = lineWith(got, "Correctness lint");
  for (const cell of ["| 4 |", "| 3 |", "| 10 |", "| 81.2 |"]) {
    assert.ok(row.includes(cell), `the part row lacks ${cell}: ${row}`);
  }
});

// Go: TestWithoutASingleScoreTheMarkdownSaysSoAndShowsTheRange.
test("without a single score the Markdown says so and shows the range", () => {
  const s = benchmarkSet((p) => {
    p.status(
      "tests.existing",
      StatusUnsupported,
      "test_runner_not_implemented",
    );
  });
  assertIncludesAll(benchmarkSection(s), [
    "**Score: none**",
    "no single score",
    "Range: 60.0 to 100.0",
    "Verdict: **incomplete**",
    "unsupported: test_runner_not_implemented",
    "unknown",
  ]);
});

// Go: TestTheMarkdownNamesFastWhenItIsWhyThereIsNoSingleScore.
test("the Markdown names --fast when it is why there is no single score", () => {
  const s = benchmarkSet((p) => {
    p.deselectByFast("tests.existing");
  });
  assert.equal(s.benchmark.score, null, "a Tests part is unknown");
  assertIncludesAll(benchmarkSection(s), [
    "**Score: none**",
    "no single score",
    "`--fast`",
    "deselected by --fast",
  ]);

  // A Check left out by --exclude is not blamed on --fast, and a --fast Run
  // whose parts are all measured says nothing about it.
  const excluded = benchmarkSection(
    benchmarkSet((p) => {
      p.deselect("tests.existing");
    }),
  );
  assert.ok(!excluded.includes("--fast"), excluded);
  const fastButMeasured = benchmarkSection(
    benchmarkSet((p) => {
      p.set.selection.fast = true;
      p.set.selection.is_standard_scope = false;
    }),
  );
  assert.ok(!fastButMeasured.includes("no single score"), fastButMeasured);
  assert.ok(!fastButMeasured.includes("--fast"), fastButMeasured);
});

// Go: TestAGateSetsTheVerdictToFailAndTheMarkdownListsIt.
test("a Gate sets the Verdict to fail and the Markdown lists it", () => {
  const s = benchmarkSet((p) => {
    p.add("syntax.parse", "SyntaxError", true);
  });
  assertIncludesAll(benchmarkSection(s), [
    "Verdict: **fail**",
    "Gates: `F-0001`",
  ]);
});

// Go: TestTheBenchmarkShowsAPartThatIsUnknownBecauseFilesDidNotParse. A Check
// made partial by files ESLint could not parse shows its reason in the
// Benchmark, and the Gaps say how many files were not parsed.
test("the Benchmark shows a part that is unknown because files did not parse", () => {
  const s = benchmarkSet((p) => {
    p.status("tests.smells", StatusPartial, "files_not_parsed");
    p.execution("tests.smells").reason =
      "ESLint could not parse 3 files in this Check's scope, so what they hold was not checked; see the Limitation files_not_parsed";
  });
  assertIncludesAll(benchmarkSection(s), [
    "**Score: none**",
    "no single score",
    "Verdict: **incomplete**",
    "partial: files_not_parsed",
  ]);
  const got = gaps(s);
  assert.ok(got.includes("could not parse 3 files"), got);
});
