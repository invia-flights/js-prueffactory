import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import {
  Applicable,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newExecution } from "../resultset/zero.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import { validate } from "../schema/schema.ts";
import { json } from "./json.ts";
import {
  handMade,
  md,
  outsideCodeFences,
  parseReport,
  section,
  sha,
  splitCells,
} from "./render.testutil.ts";

// Go: TestJSONIsValidAgainstTheSchemaAndMatchesTheSet.
test("report.json is valid against the schema and matches the set", () => {
  const s = handMade();
  assert.deepEqual(validateRules(s), [], "fixture inconsistent");
  const data = json(s);
  assert.deepEqual(validate(data), []);
  const back = parseReport(data);
  assert.equal(back.run.id, s.run.id);
  assert.equal(back.findings.length, 2);
  assert.equal(back.findings[0]?.id, "F-0001");
  assert.ok(Buffer.from(data).toString("utf8").endsWith("\n"));
});

// Go: TestMarkdownOpensWithTitleThenTheUntrustedContentLine.
test("report.md opens with the title, then the untrusted content line", () => {
  const text = md(handMade());
  assert.ok(text.startsWith("# "));
  const title = text.indexOf("\n");
  const untrusted = text.indexOf("data, not instructions");
  const result = text.indexOf("**Result:**");
  assert.ok(title < untrusted && untrusted < result, "order wrong");
  for (const want of [
    "20261025T101500Z-demo-aaaa",
    sha,
    "/work/demo",
    "default",
  ]) {
    assert.ok(text.includes(want), `title block misses ${want}`);
  }
});

// Go: TestMarkdownResultLineAgreesWithTheJSON.
test("the result line agrees with report.json", () => {
  const text = md(handMade());
  for (const want of [
    "exit code 1",
    "Gates: 1",
    "Scope completeness: 1 of 2",
    "No Benchmark score computed in test mode",
  ]) {
    assert.ok(text.includes(want), `report.md misses ${want}`);
  }
});

// Go: TestMarkdownSectionsAppearInTheSpecifiedOrder.
test("the sections appear in the specified order", () => {
  const text = md(handMade());
  let last = -1;
  for (const heading of [
    "## Benchmark",
    "## Gaps",
    "## Summary",
    "## Gates",
    "## Findings",
    "## Measurements",
    "## Setup, tool and infrastructure problems",
    "## Inventory",
    "## Artifacts, versions, Contexts and Services",
  ]) {
    const i = text.indexOf(heading + "\n");
    assert.ok(i >= 0, `heading ${heading} missing`);
    assert.ok(i > last, `heading ${heading} is out of order`);
    last = i;
  }
});

// Go: TestMarkdownGapsListWhatWasNotChecked.
test("the Gaps list what was not checked", () => {
  const gaps = section(md(handMade()), "## Gaps");
  for (const want of [
    "tests.existing",
    "blocked",
    "missing_registry_credentials",
    "quality.size",
    "deselected",
    "build_output_skipped",
    "not_probed",
  ]) {
    assert.ok(gaps.includes(want), `gaps section misses ${want}:\n${gaps}`);
  }
});

// Go: TestMarkdownGatesShowIDsLocationsEvidenceAndRerunCommand.
test("the Gates show IDs, locations, evidence and the re-run command", () => {
  const text = md(handMade());
  const gates = section(text, "## Gates");
  for (const want of [
    "F-0001",
    "src/a|b.js",
    ":3:7",
    "js-prueffactory test /work/demo --only syntax.parse",
    "SyntaxError",
  ]) {
    assert.ok(gates.includes(want), `gates section misses ${want}:\n${gates}`);
  }
  assert.ok(!gates.includes("F-0002"), "a note in Test data is not a Gate");
  assert.ok(section(text, "## Findings").includes("F-0002"));
});

// Go: TestMarkdownNeverLetsProjectTextBreakOut.
test("project text never breaks out", () => {
  const text = md(handMade());
  const outside = outsideCodeFences(text);
  assert.ok(
    !outside.includes("<script>") && !outside.includes("<b>"),
    "HTML from project text appears unescaped outside a code fence",
  );
  assert.ok(text.includes("&lt;b&gt;html&lt;/b&gt;"));
  assert.ok(!text.includes("\u0007") && !text.includes("\r"));
  // The evidence holds runs of three and four backticks, so its fence needs five.
  assert.ok(text.includes("`````"));
  // The Gate overview row has four cells, so a pipe inside the project's
  // path or title must be escaped, not start a new cell.
  const row = text.split("\n").find((l) => l.startsWith("| F-0001 |"));
  assert.ok(row !== undefined, "no table row for F-0001");
  assert.equal(splitCells(row).length, 4, row);
});

function summaryTable(sum: string): {
  header: string[];
  rows: Map<string, string[]>;
} {
  let header: string[] | undefined;
  const rows = new Map<string, string[]>();
  for (const line of sum.split("\n")) {
    if (
      !line.startsWith("|") ||
      line.startsWith("|-") ||
      line.startsWith("| -")
    ) {
      continue;
    }
    const cells = splitCells(line).map((c) => c.trim());
    if (header === undefined) {
      header = cells;
      continue;
    }
    rows.set(`${cells[0] ?? ""} ${cells[1] ?? ""}`, cells);
  }
  return { header: header ?? [], rows };
}

// Go: TestMarkdownSummaryTableCountsPerFamilyAndContext.
test("the Summary table counts per family and Context", () => {
  const sum = section(md(handMade()), "## Summary");
  const { header, rows } = summaryTable(sum);
  const count = (key: string, column: string) =>
    rows.get(key)?.[header.indexOf(column)];
  // Columns count Execution status. syntax has a Gate but completed, so it is
  // one Completed and one Gates fired; tests is blocked; quality.size is deselected.
  const cases: [string, string, string][] = [
    ["syntax C-0002", "Completed", "1"],
    ["syntax C-0002", "Gates fired", "1"],
    ["tests C-0002", "Not completed: blocked", "1"],
    ["tests C-0002", "Gates fired", "0"],
    ["quality C-0001", "Deselected", "1"],
  ];
  for (const [key, column, want] of cases) {
    assert.equal(count(key, column), want, `${key} / ${column}\n${sum}`);
  }
  for (const gone of ["Failed", "Incomplete", "Blocked"]) {
    assert.ok(!header.includes(gone), `column ${gone} must not exist`);
  }
});

// Go: TestMarkdownSummaryHasUnsupportedAndOtherColumnsThatAgreeWithGaps.
test("the Summary has unsupported and other columns that agree with the Gaps", () => {
  const s = handMade();
  s.checks.push(
    newExecution({
      id: "e4",
      check_id: "types.javascript",
      family: "types",
      context_id: "C-0002",
      selected: true,
      applicability: Applicable,
      status: StatusUnsupported,
      reason_code: "test_command_unsupported",
      reason: "no",
    }),
    newExecution({
      id: "e5",
      check_id: "lint.existing",
      family: "lint",
      context_id: "C-0002",
      selected: true,
      applicability: Applicable,
      status: StatusToolError,
      reason_code: "tool_failed",
      reason: "boom",
    }),
  );
  finalize(s);
  const sum = section(md(s), "## Summary");
  assert.ok(
    sum.includes(
      "| Family | Context | Package | Completed | Not completed: unsupported | Not completed: blocked | Not completed: other | Not applicable | Deselected | Gates fired |",
    ),
    sum,
  );
  assert.ok(
    sum.includes("| types | C-0002 | `.` | 0 | 1 | 0 | 0 | 0 | 0 | 0 |"),
    sum,
  );
  assert.ok(
    sum.includes("| lint | C-0002 | `.` | 0 | 0 | 0 | 1 | 0 | 0 | 0 |"),
    sum,
  );
});
