import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isControl } from "../gocompat/strings.ts";
import { finalize } from "../resultset/finalize.ts";
import { finding } from "../resultset/resultsettest/findings.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import {
  Applicable,
  type Set,
  StatusCompleted,
  TrustUntrusted,
} from "../resultset/types.ts";
import { newEvidence, newExecution, newMetric } from "../resultset/zero.ts";
import { validate as validateRules } from "../resultset/validate.ts";
import { json } from "./json.ts";
import {
  checkFences,
  handMade,
  md,
  outsideCodeFences,
  parseReport,
  section,
  splitCells,
  stripCodeSpans,
} from "./render.testutil.ts";

// hostileTexts are the awkward strings every text field of a Finding gets.
const hostileTexts: Record<string, string> = {
  crlf: "first\r\nsecond\rthird",
  tabs: "a\tb\t\tc",
  astral: "emoji \u{1F600} and math \u{1D54F} and \u{10348}",
  backticks: "run ` and `` and ``` and ```` and `````` end",
  pipes: "a|b || c \\| d",
  html: "<script>alert(1)</script> <img src=x onerror=y> &amp; &lt;",
  control: "bell\u0007 nul\u0000 esc\u001b[31m del\u007f c1\u0085 end",
  markdown:
    "# heading\n- item\n1. numbered\n> quote\n---\n[link](http://evil.example)\n[ref]: http://evil.example\n**bold** _it_ ~~x~~ ![img](x)",
  fence: "```\nclosed early\n```\n## after",
  "blank lines": "a\n\n\n\nb",
  trailing: "ends with backtick`",
};

function hostileSet(text: string): Set {
  const s = minimal();
  const f = finding("src/" + text + ".js", text, true);
  f.message = text;
  f.rule_id = text;
  f.expected = text;
  f.actual = text;
  f.evidence = [
    newEvidence({
      kind: "tool_output",
      text,
      origin: text,
      trust: TrustUntrusted,
    }),
  ];
  const loc = f.locations[0];
  assert.ok(loc);
  loc.role = text;
  const g = finding("src/other.js", text, false);
  g.message = text;
  s.findings = [f, g];
  s.limitations = [
    { reason_code: "r", message: text, check_id: null, path: null },
  ];
  s.metrics = [
    newMetric({
      id: "m",
      check_id: "syntax.parse",
      context_id: "C-0002",
      name: text,
      unit: text,
    }),
  ];
  finalize(s);
  return s;
}

const htmlTag = /<\/?[A-Za-z!]/;

// Go: TestMarkdownTurnsHostileTextIntoInertText.
describe("hostile text becomes inert text", () => {
  for (const [name, text] of Object.entries(hostileTexts)) {
    test(name, () => {
      const s = hostileSet(text);
      assert.deepEqual(validateRules(s), [], "fixture invalid");
      const out = md(s);
      assert.ok(!out.includes("\r"), "report.md has a carriage return");
      assert.ok(!/[\ud800-\udfff]/u.test(out), "report.md has invalid UTF-8");
      for (const ch of out) {
        const c = ch.codePointAt(0) ?? 0;
        assert.ok(
          !isControl(c) || ch === "\n" || ch === "\t",
          `control character U+${c.toString(16)} survived`,
        );
      }
      const outside = stripCodeSpans(outsideCodeFences(out));
      const tag = htmlTag.exec(outside);
      assert.equal(
        tag,
        null,
        `an HTML tag appears outside code at ${outside.slice(tag?.index ?? 0, (tag?.index ?? 0) + 30)}`,
      );
      // Headings, quotes, lists and rules in the output come from the tool,
      // never from project text.
      for (const line of outside.split("\n")) {
        for (const bad of [
          "# heading",
          "## after",
          "- item",
          "1. numbered",
          "> quote",
          "---",
          "[ref]:",
          "[link](",
          "![img]",
        ]) {
          assert.ok(
            !(line.trim().startsWith(bad) && text.includes(bad)),
            `line starts with project text ${bad}: ${line}`,
          );
        }
        assert.ok(
          !(
            text.includes("[link](http") &&
            line.includes("[link](http") &&
            !line.includes("\\[link")
          ),
          `project text became a link: ${line}`,
        );
      }
      // Every table row has the cell count of its header.
      let width = 0;
      for (const line of outside.split("\n")) {
        if (!line.startsWith("|")) {
          width = 0;
          continue;
        }
        if (width === 0) {
          width = splitCells(line).length;
        } else {
          assert.equal(splitCells(line).length, width, line);
        }
      }
      assert.equal(checkFences(out), undefined);
    });
  }
});

// Go: TestMarkdownFenceIsLongerThanAnyBacktickRunInsideIt.
test("a fence is longer than any backtick run inside it", () => {
  for (const run of [1, 3, 4, 7, 12]) {
    const out = md(hostileSet("before " + "`".repeat(run) + " after"));
    const want = "`".repeat(Math.max(3, run + 1));
    assert.ok(out.includes("\n" + want + "\n"), `a run of ${String(run)}`);
    assert.equal(checkFences(out), undefined);
  }
});

// Go: TestMarkdownKeepsTabsInsideFencesAndAstralCharactersWhole.
test("tabs inside fences and astral characters stay whole", () => {
  assert.ok(md(hostileSet("a\tb \u{1F600}")).includes("a\tb \u{1F600}\n"));
});

function manyFindings(n: number, gate: boolean): Set {
  const s = minimal();
  for (let i = 0; i < n; i++) {
    s.findings.push(
      finding(
        `src/f${String(i).padStart(3, "0")}.js`,
        `Finding ${String(i)}`,
        gate,
      ),
    );
  }
  finalize(s);
  return s;
}

// Go: TestMarkdownShowsAtMost50FindingsPerCheckAndPointsToTheJSONForTheRest.
describe("at most 50 Findings per Check, the rest in report.json", () => {
  for (const gate of [false, true]) {
    test(`gate=${String(gate)}`, () => {
      const s = manyFindings(120, gate);
      const out = md(s);
      const shown = s.findings.filter(
        (f) =>
          out.includes(f.id + "]") ||
          out.includes("### " + f.id + ":") ||
          out.includes("- " + f.id + " "),
      ).length;
      assert.equal(shown, 50);
      assert.ok(
        out.includes(
          `70 more Findings, ${s.findings[50]?.id ?? ""} to ${s.findings[119]?.id ?? ""}, in report.json`,
        ),
      );
      assert.ok(out.includes(`Gates: ${gate ? "120" : "0"}.`));
    });
  }
});

// Go: TestMarkdownCapDoesNotMixDifferentChecks.
test("the cap does not mix different Checks", () => {
  const s = manyFindings(60, false);
  const other = finding("src/x.js", "other", false);
  other.check_id = "package.manifest";
  other.execution_id = "tmp-m";
  s.checks.push(
    newExecution({
      id: "tmp-m",
      check_id: "package.manifest",
      family: "package",
      context_id: "C-0002",
      selected: true,
      applicability: Applicable,
      status: StatusCompleted,
    }),
  );
  s.findings.push(other);
  finalize(s);
  const out = md(s);
  assert.ok(section(out, "## Findings").includes("10 more Findings"));
  assert.equal(out.split("more Findings").length - 1, 1);
});

// Go: TestMarkdownEmptySectionsAlwaysSayNone.
test("empty sections always say None.", () => {
  const out = md(minimal());
  for (const h of [
    "## Gates",
    "## Findings",
    "## Measurements",
    "## Setup, tool and infrastructure problems",
    "## Inventory",
  ]) {
    assert.equal(section(out, h).trim(), "None.", h);
  }
  assert.ok(!section(out, "## Summary").includes("None."));
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"));
  assert.equal(out.split("\n## ").length - 1, 9);
});

// Go: TestMarkdownEmptyArtifactsContextsAndServicesAreNamedNone.
test("empty artifacts, Contexts and Services are named None.", () => {
  const s = minimal();
  s.contexts = [];
  s.services = [];
  s.artifacts = [];
  s.checks = [];
  finalize(s);
  const out = md(s);
  const arts = section(out, "## Artifacts, versions, Contexts and Services");
  assert.equal(arts.split("None.").length - 1, 3, arts);
  assert.equal(section(out, "## Summary").trim(), "None.");
});

// Go: TestMarkdownLinksCutEvidenceToItsFullTextArtifact.
test("cut evidence links to its full text artifact", () => {
  const s = minimal();
  const f = finding("src/a.js", "long", true);
  f.evidence = [
    newEvidence({
      kind: "tool_output",
      text: "z".repeat(9000),
      origin: "node",
      trust: TrustUntrusted,
    }),
  ];
  s.findings = [f];
  finalize(s);
  const out = md(s);
  const path = s.artifacts[0]?.path ?? "";
  assert.ok(out.includes("original text had 9000 bytes"));
  assert.ok(out.includes(`full text: [${path}](${path})`));
  assert.ok(out.includes("truncated evidence items: 1"));
});

// Go: TestJSONAndMarkdownAgreeOnIDsCountsAndStatuses.
test("report.json and report.md agree on IDs, counts and statuses", () => {
  const back = parseReport(json(handMade()));
  const out = md(back);
  for (const f of back.findings) {
    assert.ok(out.includes(f.id), `finding ${f.id} missing from report.md`);
  }
  assert.ok(out.includes(`exit code ${String(back.run.exit_code)}`));
  assert.ok(out.includes(`Gates: ${String(back.summary.gates)}.`));
  const sc = back.summary.scope_completeness;
  assert.ok(
    out.includes(
      `Scope completeness: ${String(sc.completed)} of ${String(sc.required)}`,
    ),
  );
  for (const e of back.checks) {
    if (
      e.selected &&
      e.applicability === "applicable" &&
      e.status !== "completed"
    ) {
      assert.ok(section(out, "## Gaps").includes(`**${e.status}**`), e.id);
    }
  }
  for (const c of back.contexts) {
    assert.ok(out.includes(c.id), `context ${c.id} missing`);
  }
});

// Go: TestReportsAreIdenticalWhateverTheArrivalOrder.
test("the reports are identical whatever the arrival order", () => {
  const build = (reverse: boolean): Set => {
    const s = minimal();
    for (let i = 0; i < 8; i++) {
      s.findings.push(
        finding(`src/${String(i % 3)}.js`, `t${String(i)}`, i % 2 === 0),
      );
    }
    if (reverse) {
      s.findings.reverse();
    }
    finalize(s);
    return s;
  };
  const a = build(false);
  const b = build(true);
  assert.ok(Buffer.from(json(a)).equals(Buffer.from(json(b))));
  assert.equal(md(a), md(b));
});
